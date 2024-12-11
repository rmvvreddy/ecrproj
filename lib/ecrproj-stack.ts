import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { platform } from 'os';

export class EcrprojStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isProd = this.node.tryGetContext('env') === 'prod';


    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 3,
      natGatewayProvider: isProd
        ? ec2.NatProvider.gateway()
        : ec2.NatProvider.instanceV2({
            instanceType: new ec2.InstanceType("t3.micro"),
            
            
          }),
      

      subnetConfiguration: [
        { subnetType: ec2.SubnetType.PUBLIC, name: 'Public', cidrMask: 24 },
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, name: 'Private', cidrMask: 24 },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, name: 'Isolated', cidrMask: 24 },
      ],
    });



    // Create a security group for RDS
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSG', {
      vpc,
      description: 'Allow ECS tasks to access RDS',
      allowAllOutbound: true,
    });

    // Create a secret manager for RDS instance
    const rdsSecret = new secretsmanager.Secret(this, 'RdsSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: '/@"\'\\',
      },
    });

    // Create RDS instance in isolated subnet
    const rdsInstance = new rds.DatabaseInstance(this, 'RdsInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_32 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [rdsSecurityGroup],
      credentials: rds.Credentials.fromSecret(rdsSecret),
      databaseName: 'MyDatabase',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
    });

    // Create security group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for ALB',
    });

    // Allow HTTP traffic from anywhere to load balancer
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP Traffic');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS Traffic');

    // Create ALB in public subnets
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
    });

    // Create an ECS Fargate cluster in private subnets and ECS image from ECR
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
    });

  

    const myimage = new DockerImageAsset(this, 'CDKDockerImage', {
      directory: path.join(__dirname, '../appcode'),

     });

    // Create an ECS task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      
    });

    // Create a CloudWatch log group for ECS logs
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a container definition
    const container = taskDefinition.addContainer('web', {
     // image: ecs.ContainerImage.fromRegistry('nginx:latest'), // Replace with your ECR repo URI
      image:ecs.ContainerImage.fromDockerImageAsset(myimage),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'ecs-fargate-app',
        logGroup,
      }),
      environment: {
        RDS_ENDPOINT: rdsInstance.dbInstanceEndpointAddress,
      },
      secrets: {
        RDS_USERNAME: ecs.Secret.fromSecretsManager(rdsSecret, 'username'),
        RDS_PASSWORD: ecs.Secret.fromSecretsManager(rdsSecret, 'password'),
      },
    });

    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    ecsSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'Allow traffic from ALB');
    const vpcCidr = vpc.vpcCidrBlock; 
    // Get the CIDR block of the VPC 
    ecsSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.allTraffic(), 'Allow all traffic within VPC');

        // Create an ECS Fargate service with Deployment Circuit Breaker
        const ecsService = new ecs.FargateService(this, 'Service', {
          cluster,
          taskDefinition,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ecsSecurityGroup],
          circuitBreaker: {
            rollback: true, // Enable automatic rollback on failure
          },
        });
    
        // ECS port mapping to 3000
        container.addPortMappings({
          containerPort: 3000,
        });
    
        // Integrate ECS Service with ALB
        const listener = loadBalancer.addListener('Listener', {
          port: 80,
          open: true,
        });
    
        listener.addTargets('ECS', {
          port: 80,
          targets: [ecsService.loadBalancerTarget({
            containerName: 'web',
            containerPort: 3000,
          })],
          healthCheck: {
            path: "/",
            interval: cdk.Duration.seconds(30),
            timeout: cdk.Duration.seconds(5),
            healthyHttpCodes: "200-299",
          },
        });
    
        rdsSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(3306), 'Allow traffic from ECS');
    
        // Create an API Gateway and integrate it with the ALB
        const api = new apigateway.RestApi(this, 'ApiGateway', {
          restApiName: 'Service API',
          description: 'API Gateway on top of ALB',
        });
    
        const integration = new apigateway.Integration({
          type: apigateway.IntegrationType.HTTP_PROXY,
          uri: `http://${loadBalancer.loadBalancerDnsName}`,
          integrationHttpMethod: 'ANY',
        });
    
        api.root.addMethod('ANY', integration);
    
        // Output the Load Balancer DNS
        new cdk.CfnOutput(this, 'LoadBalancerDNS', {
          value: loadBalancer.loadBalancerDnsName,
        });
    
        // Output the API Gateway URL
        new cdk.CfnOutput(this, 'ApiGatewayURL', {
          value: api.url,
        });









   
  }
}
