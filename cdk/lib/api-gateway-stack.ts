import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { ISchema } from "aws-cdk-lib/aws-appsync";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import {
  Architecture,
  Code,
  Function,
  LayerVersion,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { CfnJson } from "aws-cdk-lib";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import { parse, stringify } from "yaml";
import { Fn } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { SecretValue } from "aws-cdk-lib";
import { createCognitoResources } from "./api-gateway-helpers/cognito";
import { createS3Buckets } from "./api-gateway-helpers/s3";
import { createLayers } from "./api-gateway-helpers/layers";
import { createRolesAndPolicies } from "./api-gateway-helpers/roles";

export class ApiGatewayStack extends cdk.Stack {
  private readonly api: apigateway.SpecRestApi;
  public readonly appClient: cognito.UserPoolClient;
  public readonly userPool: cognito.UserPool;
  public readonly identityPool: cognito.CfnIdentityPool;
  private readonly layerList: { [key: string]: LayerVersion };
  public readonly stageARN_APIGW: string;
  public readonly apiGW_basedURL: string;
  public readonly secret: secretsmanager.ISecret;
  private eventApi: appsync.GraphqlApi;
  public getEndpointUrl = () => this.api.url;
  private downloadMessagesApi: appsync.GraphqlApi;
  private compTextGenApi: appsync.GraphqlApi;
  public getUserPoolId = () => this.userPool.userPoolId;
  public getUserPoolClientId = () => this.appClient.userPoolClientId;
  public getEventApiUrl = () => this.eventApi.graphqlUrl;
  public getDownloadMessagesApiUrl = () => this.downloadMessagesApi.graphqlUrl;
  public getCompTextGenApiUrl = () => this.compTextGenApi.graphqlUrl;
  public getIdentityPoolId = () => this.identityPool.ref;
  public addLayer = (name: string, layer: LayerVersion) =>
    (this.layerList[name] = layer);
  public getLayers = () => this.layerList;
  constructor(
    scope: Construct,
    id: string,
    db: DatabaseStack,
    vpcStack: VpcStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);
    this.layerList = {};
    const {
      embeddingStorageBucket,
      dataIngestionBucket,
      comparisonBucket,
      csv_bucket,
    } = createS3Buckets(this, id);
    // Create FIFO SQS Queue
    const comparisonQueue = new sqs.Queue(this, `${id}-ComparisonQueue`, {
      queueName: `${id}-comparison-queue.fifo`,
      fifo: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      visibilityTimeout: cdk.Duration.seconds(900),
    });

    // Create FIFO SQS Queue
    const csvQueue = new sqs.Queue(this, `${id}-CsvQueue`, {
      queueName: `${id}-csv-queue.fifo`,
      fifo: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      visibilityTimeout: cdk.Duration.seconds(900),
    });

    // Create FIFO SQS Queue
    const compTextGenQueue = new sqs.Queue(this, `${id}-CompTextGenQueue`, {
      queueName: `${id}-CompTextGen-queue.fifo`,
      fifo: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      visibilityTimeout: cdk.Duration.seconds(900),
    });

    const { jwt, postgres, psycopgLayer } = createLayers(this, id);
    this.layerList["psycopg2"] = psycopgLayer;
    this.layerList["postgres"] = postgres;
    this.layerList["jwt"] = jwt;

    // powertoolsLayer does not follow the format of layerList
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      `${id}-PowertoolsLayer`,
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:78`
    );

    this.layerList["psycopg2"] = psycopgLayer;
    this.layerList["postgres"] = postgres;
    this.layerList["jwt"] = jwt;

    const { userPool, appClient, identityPool, secret } =
      createCognitoResources(this, id);

    this.userPool = userPool;
    this.appClient = appClient;
    this.identityPool = identityPool;
    this.secret = secret;

    // Create roles and policies
    const createPolicyStatement = (actions: string[], resources: string[]) => {
      return new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: resources,
      });
    };

    /**
     * Load OpenAPI file into API Gateway using REST API
     */
    // Read OpenAPI file and load file to S3
    const asset = new Asset(this, "SampleAsset", {
      path: "OpenAPI_Swagger_Definition.yaml",
    });

    const data = Fn.transform("AWS::Include", { Location: asset.s3ObjectUrl });

    // Create the API Gateway REST API
    this.api = new apigateway.SpecRestApi(this, `${id}-APIGateway`, {
      apiDefinition: apigateway.AssetApiDefinition.fromInline(data),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      restApiName: `${id}-API`,
      deploy: true,
      cloudWatchRole: true,
      deployOptions: {
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        dataTraceEnabled: true,
        stageName: "prod",
        methodOptions: {
          "/*/*": {
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
          },
        },
      },
    });

    this.stageARN_APIGW = this.api.deploymentStage.stageArn;
    this.apiGW_basedURL = this.api.urlForPath();

    const { adminRole, unauthenticatedRole } = createRolesAndPolicies(
      this,
      id,
      this.identityPool.ref,
      this.api.restApiId,
      this.region,
      this.account
    );
    const adminGroup = new cognito.CfnUserPoolGroup(this, `${id}-AdminGroup`, {
      groupName: "admin",
      userPoolId: this.userPool.userPoolId,
      roleArn: adminRole.roleArn,
    });

    const lambdaRole = new iam.Role(this, `${id}-postgresLambdaRole`, {
      roleName: `${id}-postgresLambdaRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // Grant access to Secret Manager
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to EC2
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // Inline policy to allow AdminAddUserToGroup action
    const adminAddUserToGroupPolicyLambda = new iam.Policy(
      this,
      `${id}-adminAddUserToGroupPolicyLambda`,
      {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "cognito-idp:AdminAddUserToGroup",
              "cognito-idp:AdminRemoveUserFromGroup",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminListGroupsForUser",
            ],
            resources: [
              `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}`,
            ],
          }),
        ],
      }
    );

    // Attach the inline policy to the role
    lambdaRole.attachInlinePolicy(adminAddUserToGroupPolicyLambda);

    // Attach roles to the identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: adminRole.roleArn,
        unauthenticated: unauthenticatedRole.roleArn,
      },
    });


    this.eventApi = new appsync.GraphqlApi(this, `${id}-EventApi`, {
      name: `${id}-EventApi`,
      definition: appsync.Definition.fromFile("./graphql/schema.graphql"),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      xrayEnabled: true,
    });
    

    this.downloadMessagesApi = new appsync.GraphqlApi(
      this,
      `${id}-downloadMessagesApi`,
      {
        name: `${id}-downloadMessagesApi`,
        definition: appsync.Definition.fromFile("./graphql/schema.graphql"),
        authorizationConfig: {
          defaultAuthorization: {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        },
        xrayEnabled: true,
      }
    );

    this.compTextGenApi = new appsync.GraphqlApi(this, `${id}-CompTextGenApi`, {
      name: `${id}-CompTextGenApi`,
      definition: appsync.Definition.fromFile("./graphql/schema.graphql"),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      xrayEnabled: true,
    });

    const notificationFunction = new lambda.Function(
      this,
      `${id}-NotificationFunction`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/eventNotification"),
        handler: "eventNotification.lambda_handler",
        environment: {
          DOWNLOAD_MESSAGES_API: this.downloadMessagesApi.graphqlUrl,
          DOWNLOAD_MESSAGES_API_KEY: this.downloadMessagesApi.apiKey!,
          APPSYNC_API_URL: this.eventApi.graphqlUrl,
          APPSYNC_API_ID: this.eventApi.apiId,
          REGION: this.region,
        },
        functionName: `${id}-NotificationFunction`,
        timeout: cdk.Duration.seconds(300),
        memorySize: 128,
        vpc: vpcStack.vpc,
        role: lambdaRole,
      }
    );

    //#removerd graphql permission

    notificationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `arn:aws:appsync:${this.region}:${this.account}:apis/${this.eventApi.apiId}/*`,
          `arn:aws:appsync:${this.region}:${this.account}:apis/${this.downloadMessagesApi.apiId}/*`,
          `arn:aws:appsync:${this.region}:${this.account}:apis/${this.compTextGenApi.apiId}/*`,
        ],
      })
    );

    notificationFunction.addPermission("AppSyncInvokePermission", {
      principal: new iam.ServicePrincipal("appsync.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.eventApi.apiId}/*`,
    });
    
    notificationFunction.addPermission("AppSyncInvokePermissionDownloadMessagesApi", {
      principal: new iam.ServicePrincipal("appsync.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.downloadMessagesApi.apiId}/*`,
    });
    
    notificationFunction.addPermission("AppSyncInvokePermissionCompTextGenApi", {
      principal: new iam.ServicePrincipal("appsync.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.compTextGenApi.apiId}/*`,
    });
    

    const notificationLambdaDataSource = this.eventApi.addLambdaDataSource(
      "NotificationLambdaDataSource",
      notificationFunction
    );


    const compTextGenLambdaDataSource = this.compTextGenApi.addLambdaDataSource(
      "CompTextGenLambdaDataSource",
      notificationFunction
    );

    const getChatHistoryLambdaDataSource = this.downloadMessagesApi.addLambdaDataSource(
      "getChatHistoryLambdaDataSource",
      notificationFunction
    );

    compTextGenLambdaDataSource.createResolver("ResolverCompTextGenApi", {
      typeName: "Mutation",
      fieldName: "sendNotification",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });


    notificationLambdaDataSource.createResolver("ResolverEventApi", {
      typeName: "Mutation",
      fieldName: "sendNotification",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    getChatHistoryLambdaDataSource.createResolver("ResolverdownloadMessagesApi", {
      typeName: "Mutation",
      fieldName: "sendNotification",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Add permission to allow main.py Lambda to invoke eventNotification Lambda
    notificationFunction.grantInvoke(
      new iam.ServicePrincipal("lambda.amazonaws.com")
    );

    // Override the Logical ID of the Lambdas Function to get ARN in OpenAPI
    const cfnNotificationFunction = notificationFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnNotificationFunction.overrideLogicalId("NotificationFunction");

    const chatHistory = new lambda.DockerImageFunction(this, `${id}-getChatHistory`, {
      code: lambda.DockerImageCode.fromImageAsset("./chatHistory"),
      memorySize: 512,
      timeout: cdk.Duration.seconds(600),
      vpc: vpcStack.vpc, // Pass the VPC
      functionName: `${id}-getChatHistory`,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        TABLE_NAME: "DynamoDB-Conversation-Table",
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        CHATLOGS_BUCKET: csv_bucket.bucketName,
        APPSYNC_API_URL: this.downloadMessagesApi.graphqlUrl,
        REGION: this.region,
        API_KEY: "API_KEY"
      },
    });

     // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
     const cfnGetChatHistory = chatHistory.node
      .defaultChild as lambda.CfnFunction;
      cfnGetChatHistory.overrideLogicalId("getChatHistory");

      // Add the permission to the Lambda function's policy to allow API Gateway access
    chatHistory.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });
    csv_bucket.grantReadWrite(chatHistory);
    csvQueue.grantConsumeMessages(chatHistory);
    chatHistory.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/DynamoDB-Conversation-Table`,
        ],
      })
    );
    // Add ListBucket permission explicitly
    chatHistory.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [csv_bucket.bucketArn], // Access to the specific bucket
      })
    );

    chatHistory.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `arn:aws:s3:::${csv_bucket.bucketName}/*`, // Grant access to all objects within this bucket
        ],
      })
    );

    // Add the S3 event source trigger to the Lambda function
    chatHistory.addEventSource(
      new lambdaEventSources.S3EventSource(csv_bucket, {
        events: [
          s3.EventType.OBJECT_CREATED,
          s3.EventType.OBJECT_REMOVED,
          s3.EventType.OBJECT_RESTORE_COMPLETED,
        ],
      })
    );

    // Grant access to Secret Manager
    chatHistory.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    chatHistory.addEventSource(
      new lambdaEventSources.SqsEventSource(csvQueue, {
        batchSize: 5,
      })
    );

    const lambdaUserFunction = new lambda.Function(this, `${id}-userFunction`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset("lambda/lib"),
      handler: "userFunction.handler",
      timeout: Duration.seconds(300),
      vpc: vpcStack.vpc,
      environment: {
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        USER_POOL: this.userPool.userPoolId,
      },
      functionName: `${id}-userFunction`,
      memorySize: 512,
      layers: [postgres],
      role: lambdaRole,
    });

    // Add the permission to the Lambda function's policy to allow API Gateway access
    lambdaUserFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    const cfnLambda_user = lambdaUserFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_user.overrideLogicalId("userFunction");

    const lambdaAdminFunction = new lambda.Function(
      this,
      `${id}-adminFunction`,
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset("lambda/adminFunction"),
        handler: "adminFunction.handler",
        timeout: Duration.seconds(300),
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathTableCreator.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpointTableCreator,
        },
        functionName: `${id}-adminFunction`,
        memorySize: 512,
        layers: [postgres],
        role: lambdaRole,
      }
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    lambdaAdminFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    const cfnLambda_Admin = lambdaAdminFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnLambda_Admin.overrideLogicalId("adminFunction");

    const coglambdaRole = new iam.Role(this, `${id}-cognitoLambdaRole`, {
      roleName: `${id}-cognitoLambdaRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    const logRole = new iam.Role(this, `${id}-logRole`, {
      roleName: `${id}-logRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    logRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    logRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to Secret Manager
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to EC2
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"], // must be *
      })
    );

    // Grant access to log
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );

    // Grant permission to add users to an IAM group
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:AddUserToGroup"],
        resources: [
          `arn:aws:iam::${this.account}:user/*`,
          `arn:aws:iam::${this.account}:group/*`,
        ],
      })
    );

    // Inline policy to allow AdminAddUserToGroup action
    const adminAddUserToGroupPolicy = new iam.Policy(
      this,
      `${id}-AdminAddUserToGroupPolicy`,
      {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "cognito-idp:AdminAddUserToGroup",
              "cognito-idp:AdminRemoveUserFromGroup",
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminListGroupsForUser",
            ],
            resources: [
              `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}`,
            ],
          }),
        ],
      }
    );

    // Attach the inline policy to the role
    coglambdaRole.attachInlinePolicy(adminAddUserToGroupPolicy);

    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // Secrets Manager
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    const AutoSignupLambda = new lambda.Function(
      this,
      `${id}-addAdminOnSignUp`,
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset("lambda/lib"),
        handler: "addAdminOnSignUp.handler",
        timeout: Duration.seconds(300),
        environment: {
          SM_DB_CREDENTIALS: db.secretPathTableCreator.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpointTableCreator,
        },
        vpc: vpcStack.vpc,
        functionName: `${id}-addAdminOnSignUp`,
        memorySize: 128,
        layers: [postgres],
        role: coglambdaRole,
      }
    );

    //cognito auto assign authenticated users to the admin group

    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      AutoSignupLambda
    );

    new cdk.CfnOutput(this, `${id}-UserPoolIdOutput`, {
      value: this.userPool.userPoolId,
      description: "The ID of the Cognito User Pool",
    });

    const updateTimestampLambda = new lambda.Function(
      this,
      `${id}-updateTimestampLambda`,
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset("lambda/lib"),
        handler: "updateLastSignIn.handler",
        timeout: Duration.seconds(300),
        environment: {
          SM_DB_CREDENTIALS: db.secretPathTableCreator.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpointTableCreator,
        },
        vpc: vpcStack.vpc,
        functionName: `${id}-updateLastSignIn`,
        memorySize: 128,
        layers: [postgres],
        role: coglambdaRole,
      }
    );

    //cognito auto assign authenticated users to the admin group

    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_AUTHENTICATION,
      updateTimestampLambda
    );

    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/*`],
      })
    );

    const preSignupLambda = new lambda.Function(this, "preSignupLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset("lambda/lib"),
      handler: "preSignup.handler",
      timeout: Duration.seconds(300),
      environment: {
        ALLOWED_EMAIL_DOMAINS: "/DSA/AllowedEmailDomains",
      },
      vpc: vpcStack.vpc,
      functionName: `${id}-preSignupLambda`,
      memorySize: 128,
      role: coglambdaRole,
    });

    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      preSignupLambda
    );

    // **
    //  *
    //  * Create Lambda for Admin Authorization endpoints
    //  */
    const authorizationFunction = new lambda.Function(
      this,
      `${id}-admin-authorization-api-gateway`,
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset("lambda/adminAuthorizerFunction"),
        handler: "adminAuthorizerFunction.handler",
        timeout: Duration.seconds(300),
        vpc: vpcStack.vpc,
        environment: {
          SM_COGNITO_CREDENTIALS: this.secret.secretName,
        },
        functionName: `${id}-adminLambdaAuthorizer`,
        memorySize: 512,
        layers: [jwt],
        role: lambdaRole,
      }
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    authorizationFunction.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    );

    // Change Logical ID to match the one decleared in YAML file of Open API
    const apiGW_authorizationFunction = authorizationFunction.node
      .defaultChild as lambda.CfnFunction;
    apiGW_authorizationFunction.overrideLogicalId("adminLambdaAuthorizer");

    // Create parameters for Bedrock LLM ID, Embedding Model ID, and Table Name in Parameter Store
    const bedrockLLMParameter = new ssm.StringParameter(
      this,
      "BedrockLLMParameter",
      {
        parameterName: `/${id}/DSA/BedrockLLMId`,
        description: "Parameter containing the Bedrock LLM ID",
        stringValue: "meta.llama3-3-70b-instruct-v1:0",
      }
    );
    const embeddingModelParameter = new ssm.StringParameter(
      this,
      "EmbeddingModelParameter",
      {
        parameterName: `/${id}/DSA/EmbeddingModelId`,
        description: "Parameter containing the Embedding Model ID",
        stringValue: "amazon.titan-embed-text-v2:0",
      }
    );

    const tableNameParameter = new ssm.StringParameter(
      this,
      "TableNameParameter",
      {
        parameterName: `/${id}/DSA/TableName`,
        description: "Parameter containing the DynamoDB table name",
        stringValue: "DynamoDB-Conversation-Table",
      }
    );

    const documentCompFunc = new lambda.DockerImageFunction(
      this,
      `${id}-documentCompFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./comparison_text_generation"),
        memorySize: 2048,
        timeout: cdk.Duration.seconds(300),
        vpc: vpcStack.vpc, // Pass the VPC
        functionName: `${id}-documentCompFunction`,
        environment: {
          SM_DB_COMP_CREDENTIALS: db.comparisonSecretPathUser.secretName,
          RDS_PROXY_COMP_ENDPOINT: db.comparisonRDSProxyEndpoint,
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
          BEDROCK_LLM_PARAM: bedrockLLMParameter.parameterName,
          EMBEDDING_MODEL_PARAM: embeddingModelParameter.parameterName,
          TABLE_NAME_PARAM: tableNameParameter.parameterName,
          COMP_TEXT_GEN_QUEUE_URL: compTextGenQueue.queueUrl,
          APPSYNC_API_URL: this.compTextGenApi.graphqlUrl,
          API_KEY: "API_KEY"
        },
      }
    );

    documentCompFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateGuardrail",
          "bedrock:CreateGuardrailVersion",
          "bedrock:DeleteGuardrail", // Permission to create guardrails
          "bedrock:ListGuardrails",  // (Optional) To list existing guardrails
          "bedrock:InvokeGuardrail",
          "bedrock:ApplyGuardrail"  // (Optional) To invoke the guardrail for filtering
        ],
        resources: ["*"], // Replace with specific resource ARNs if available
      })
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfndocumentCompFunc = documentCompFunc.node
      .defaultChild as lambda.CfnFunction;
    cfndocumentCompFunc.overrideLogicalId("documentCompFunction");

    // Add the permission to the Lambda function's policy to allow API Gateway access
    documentCompFunc.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    // Grant access to Secret Manager
    documentCompFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );
    
    // Grant access to SSM Parameter Store for specific parameters
    documentCompFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          bedrockLLMParameter.parameterArn,
          embeddingModelParameter.parameterArn,
          tableNameParameter.parameterArn,
        ],
      })
    );

    documentCompFunc.addEventSource(
      new lambdaEventSources.SqsEventSource(compTextGenQueue, {
        batchSize: 5,
      })
    );
    /**
     *
     * Create Lambda with container image for text generation workflow in RAG pipeline
     */
    const textGenFunc = new lambda.DockerImageFunction(
      this,
      `${id}-TextGenFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./text_generation"),
        memorySize: 2048,
        timeout: cdk.Duration.seconds(300),
        vpc: vpcStack.vpc, // Pass the VPC
        functionName: `${id}-TextGenFunction`,
        environment: {
          SM_DB_COMP_CREDENTIALS: db.comparisonSecretPathUser.secretName,
          RDS_PROXY_COMP_ENDPOINT: db.comparisonRDSProxyEndpoint,
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
          BEDROCK_LLM_PARAM: bedrockLLMParameter.parameterName,
          EMBEDDING_MODEL_PARAM: embeddingModelParameter.parameterName,
          TABLE_NAME_PARAM: tableNameParameter.parameterName,
          COMP_TEXT_GEN_QUEUE_URL: compTextGenQueue.queueUrl,
        },
      }
    );

    textGenFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateGuardrail", // Permission to create guardrails
          "bedrock:ListGuardrails",  // (Optional) To list existing guardrails
          "bedrock:InvokeGuardrail",
          "bedrock:ApplyGuardrail"  // (Optional) To invoke the guardrail for filtering
        ],
        resources: ["arn:aws:bedrock:"+this.region+":"+this.account+":guardrail/*"], // Replace with specific resource ARNs if available
      })
    );
  

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnTextGenDockerFunc = textGenFunc.node
      .defaultChild as lambda.CfnFunction;
    cfnTextGenDockerFunc.overrideLogicalId("TextGenLambdaDockerFunction");

    // Add the permission to the Lambda function's policy to allow API Gateway access
    textGenFunc.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    // Custom policy statement for Bedrock access
//     const bedrockPolicyStatement = new iam.PolicyStatement({
//       effect: iam.Effect.ALLOW,
//       actions: ["bedrock:InvokeModel", "bedrock:InvokeEndpoint","bedrock:CreateInferenceProfile", "bedrock:GetInferenceProfile","bedrock:InvokeModelWithResponseStream",
//         "bedrock:ListInferenceProfiles",
//         "bedrock:DeleteInferenceProfile",
//         "bedrock:TagResource",
//         "bedrock:UntagResource",
//         "bedrock:ListTagsForResource"],
// resources: ["arn:aws:bedrock:*::foundation-model/*",
//         "arn:aws:bedrock:*:*:inference-profile/*",
//         "arn:aws:bedrock:*:*:application-inference-profile/*",
//          "arn:aws:bedrock:*:*:inference-profile/*",
//         "arn:aws:bedrock:*:*:application-inference-profile/*",
//         "arn:aws:bedrock:" +
//           this.region +
//           "::foundation-model/amazon.titan-embed-text-v2:0",
//       ],
//     });

    const bedrockPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["bedrock:InvokeModel", "bedrock:InvokeEndpoint"],
      resources: [
        "arn:aws:bedrock:" +
          this.region +
          "::foundation-model/meta.llama3-3-70b-instruct-v1:0",
        "arn:aws:bedrock:" +
          this.region +
          "::foundation-model/amazon.titan-embed-text-v2:0",
      ],
    });

    

    // Attach the custom Bedrock policy to Lambda function
    textGenFunc.addToRolePolicy(bedrockPolicyStatement);
    documentCompFunc.addToRolePolicy(bedrockPolicyStatement);
    // textGenFunc.addToRolePolicy(inferencePolicyStatement);

    // Grant access to Secret Manager
    textGenFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to DynamoDB actions
    textGenFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:ListTables",
          "dynamodb:CreateTable",
          "dynamodb:DescribeTable",
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
        ],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/*`],
      })
    );
    // Grant access to SSM Parameter Store for specific parameters
    textGenFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          bedrockLLMParameter.parameterArn,
          embeddingModelParameter.parameterArn,
          tableNameParameter.parameterArn,
        ],
      })
    );

    // Grant access to S3 bucket for text extraction data
    textGenFunc.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket", "s3:GetObject"],
        resources: [
          `arn:aws:s3:::text-extraction-data-dls`,
          `arn:aws:s3:::text-extraction-data-dls/*`,
        ],
      })
    );

    // Create the Lambda function for generating presigned URLs for comparison bucket
    const comparisonGeneratePreSignedURL = new lambda.Function(
      this,
      `${id}-ComparisonPreSignedURLFunc`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/comparisonPreSignedURL"),
        handler: "comparisonPreSignedURL.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 2048,
        environment: {
          BUCKET: comparisonBucket.bucketName,
          REGION: this.region,
        },
        functionName: `${id}-ComparisonPreSignedURLFunc`,
        layers: [powertoolsLayer],
        role: lambdaRole,
      }
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnComparisonPreSignedURL = comparisonGeneratePreSignedURL.node
      .defaultChild as lambda.CfnFunction;
    cfnComparisonPreSignedURL.overrideLogicalId("ComparisonPreSignedURLFunc");

    // Grant the Lambda function the necessary permissions
    comparisonBucket.grantReadWrite(comparisonGeneratePreSignedURL);
    comparisonGeneratePreSignedURL.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [
          comparisonBucket.bucketArn,
          `${comparisonBucket.bucketArn}/*`,
        ],
      })
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    comparisonGeneratePreSignedURL.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/user*`,
    });

    // First Lambda Function (S3 Ingestion)
    const csvFunction = new lambda.Function(this, `${id}-csvFunction`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "csv.handler",
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/lib"),
      timeout: cdk.Duration.seconds(900),
      environment: {
        SQS_QUEUE_URL: csvQueue.queueUrl,
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
      },
      layers: [postgres],
      vpc: vpcStack.vpc,
      role: coglambdaRole,
    });

    csvQueue.grantSendMessages(csvFunction);

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnCsvFunction = csvFunction.node.defaultChild as lambda.CfnFunction;
    cfnCsvFunction.overrideLogicalId("csvFunction");

    // Add the permission to the Lambda function's policy to allow API Gateway access
    csvFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });


    // First Lambda Function (S3 Ingestion)
    const compTextGenFunction = new lambda.Function(this, `${id}-CompTextGenFunction`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "compsqs.handler",
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/sqs"),
      timeout: cdk.Duration.seconds(900),
      environment: {
        SQS_QUEUE_URL: compTextGenQueue.queueUrl,
      },
      vpc: vpcStack.vpc,
      role: coglambdaRole,
    });

    // compTextGenQueue.grantSendMessages(compTextGenFunction);
    compTextGenQueue.grantConsumeMessages(documentCompFunc);
    compTextGenQueue.grantSendMessages(textGenFunc);
    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfncompTextGenFunction = compTextGenFunction.node.defaultChild as lambda.CfnFunction;
    cfncompTextGenFunction.overrideLogicalId("compTextGenFunction");

    // Add the permission to the Lambda function's policy to allow API Gateway access
    compTextGenFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    // First Lambda Function (S3 Ingestion)
    const sqsFunction = new lambda.Function(this, `${id}-sqsFunction`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "sqs.handler",
      memorySize: 512,
      code: lambda.Code.fromAsset("lambda/sqs"),
      timeout: cdk.Duration.seconds(900),
      environment: {
        SQS_QUEUE_URL: comparisonQueue.queueUrl,
      },
      vpc: vpcStack.vpc,
      role: coglambdaRole,
    });

    sqsFunction.addEventSource(
      new lambdaEventSources.S3EventSource(comparisonBucket, {
        events: [
          s3.EventType.OBJECT_CREATED,
          s3.EventType.OBJECT_RESTORE_COMPLETED,
        ],
      })
    );

    comparisonQueue.grantSendMessages(sqsFunction);

    /**
     *
     * Create Lambda with container image for data ingestion workflow in RAG pipeline
     * This function will be triggered when a file in uploaded or deleted fro, the S3 Bucket
     */
    const comparisonDataIngestFunction = new lambda.DockerImageFunction(
      this,
      `${id}-ComparisonDataIngestFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset(
          "./comparison_data_ingestion"
        ),
        memorySize: 2048,
        timeout: cdk.Duration.seconds(600),
        vpc: vpcStack.vpc, // Pass the VPC
        functionName: `${id}-ComparisonDataIngestFunction`,
        environment: {
          SM_DB_CREDENTIALS: db.comparisonSecretPathAdminName,
          RDS_PROXY_ENDPOINT: db.comparisonRdsProxyEndpointAdmin,
          BUCKET: comparisonBucket.bucketName,
          REGION: this.region,
          EMBEDDING_BUCKET_NAME: embeddingStorageBucket.bucketName,
          EMBEDDING_MODEL_PARAM: embeddingModelParameter.parameterName,
          EVENT_NOTIFICATION_LAMBDA_NAME: notificationFunction.functionName,
          APPSYNC_API_URL: this.eventApi.graphqlUrl,
          APPSYNC_API_ID: this.eventApi.apiId,
          API_KEY: "API_KEY"
        },
      }
    );

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateGuardrail",
          "bedrock:CreateGuardrailVersion",
          "bedrock:DeleteGuardrail", // Permission to create guardrails
          "bedrock:ListGuardrails",  // (Optional) To list existing guardrails
          "bedrock:InvokeGuardrail",
          "bedrock:ApplyGuardrail"  // (Optional) To invoke the guardrail for filtering
        ],
        resources: ["*"], // Replace with specific resource ARNs if available
      })
    );
    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnComparisonLambdaDockerFunction = comparisonDataIngestFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnComparisonLambdaDockerFunction.overrideLogicalId(
      "ComparisonDataIngestFunction"
    );

    comparisonBucket.grantRead(comparisonDataIngestFunction);

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [comparisonBucket.bucketArn], // Access to the specific bucket
      })
    );

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:DeleteObject"],
        resources: [comparisonBucket.bucketArn], // Access to the specific bucket
      })
    );

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [embeddingStorageBucket.bucketArn], // Access to the specific bucket
      })
    );

    comparisonDataIngestFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(comparisonQueue, {
        batchSize: 5,
      })
    );

    comparisonQueue.grantConsumeMessages(comparisonDataIngestFunction);

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `arn:aws:s3:::${embeddingStorageBucket.bucketName}/*`, // Grant access to all objects within this bucket
        ],
      })
    );

    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `arn:aws:s3:::${comparisonBucket.bucketName}/*`, // Grant access to all objects within this bucket
        ],
      })
    );
    comparisonDataIngestFunction.addToRolePolicy(bedrockPolicyStatement);
    // comparisonDataIngestFunction.addToRolePolicy(inferencePolicyStatement);
    // Grant access to Secret Manager
    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to SSM Parameter Store for specific parameters
    comparisonDataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [embeddingModelParameter.parameterArn],
      })
    );

    notificationFunction.grantInvoke(comparisonDataIngestFunction);

    // Create the Lambda function for generating presigned URLs
    const generatePreSignedURL = new lambda.Function(
      this,
      `${id}-GeneratePreSignedURLFunc`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/generatePreSignedURL"),
        handler: "generatePreSignedURL.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 128,
        environment: {
          BUCKET: dataIngestionBucket.bucketName,
          REGION: this.region,
        },
        functionName: `${id}-GeneratePreSignedURLFunc`,
        layers: [powertoolsLayer],
        role: lambdaRole,
      }
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnGeneratePreSignedURL = generatePreSignedURL.node
      .defaultChild as lambda.CfnFunction;
    cfnGeneratePreSignedURL.overrideLogicalId("GeneratePreSignedURLFunc");

    // Grant the Lambda function the necessary permissions
    dataIngestionBucket.grantReadWrite(generatePreSignedURL);
    generatePreSignedURL.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [
          dataIngestionBucket.bucketArn,
          `${dataIngestionBucket.bucketArn}/*`,
        ],
      })
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    generatePreSignedURL.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    /**
     *
     * Create Lambda with container image for data ingestion workflow in RAG pipeline
     * This function will be triggered when a file in uploaded or deleted fro, the S3 Bucket
     */
    const dataIngestFunction = new lambda.DockerImageFunction(
      this,
      `${id}-DataIngestFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./data_ingestion"),
        memorySize: 2048,
        timeout: cdk.Duration.seconds(600),
        vpc: vpcStack.vpc, // Pass the VPC
        functionName: `${id}-DataIngestFunction`,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathAdminName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpointAdmin,
          BUCKET: dataIngestionBucket.bucketName,
          REGION: this.region,
          EMBEDDING_BUCKET_NAME: embeddingStorageBucket.bucketName,
          EMBEDDING_MODEL_PARAM: embeddingModelParameter.parameterName,
        },
      }
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnDataIngestLambdaDockerFunction = dataIngestFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnDataIngestLambdaDockerFunction.overrideLogicalId(
      "DataIngestLambdaDockerFunctionReImaged"
    );

    dataIngestionBucket.grantRead(dataIngestFunction);

    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [dataIngestionBucket.bucketArn], // Access to the specific bucket
      })
    );

    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [embeddingStorageBucket.bucketArn], // Access to the specific bucket
      })
    );

    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `arn:aws:s3:::${embeddingStorageBucket.bucketName}/*`, // Grant access to all objects within this bucket
        ],
      })
    );

    dataIngestFunction.addToRolePolicy(bedrockPolicyStatement);
    // dataIngestFunction.addToRolePolicy(inferencePolicyStatement);

    dataIngestFunction.addEventSource(
      new lambdaEventSources.S3EventSource(dataIngestionBucket, {
        events: [
          s3.EventType.OBJECT_CREATED,
          s3.EventType.OBJECT_REMOVED,
          s3.EventType.OBJECT_RESTORE_COMPLETED,
        ],
      })
    );

    // Grant access to Secret Manager
    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Grant access to SSM Parameter Store for specific parameters
    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [embeddingModelParameter.parameterArn],
      })
    );

    /**
     *
     * Create Lambda function that will return all file names for a specified course, concept, and module
     */
    const getDocumentsFunction = new lambda.Function(
      this,
      `${id}-GetDocumentsFunction`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/getDocumentsFunction"),
        handler: "getDocumentsFunction.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 128,
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName,
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          BUCKET: dataIngestionBucket.bucketName,
          REGION: this.region,
        },
        functionName: `${id}-GetDocumentsFunction`,
        layers: [psycopgLayer, powertoolsLayer],
        role: coglambdaRole,
      }
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnGetDocumentsFunction = getDocumentsFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnGetDocumentsFunction.overrideLogicalId("GetDocumentsFunction");

    // Grant the Lambda function read-only permissions to the S3 bucket
    dataIngestionBucket.grantRead(getDocumentsFunction);

    // Grant access to Secret Manager
    getDocumentsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    getDocumentsFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    /**
     *
     * Create Lambda function to delete certain file
     */
    const deleteDocument = new lambda.Function(
      this,
      `${id}-DeleteDocumentFunc`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/deleteDocument"),
        handler: "deleteDocument.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 128,
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName, // Database User Credentials
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint, // RDS Proxy Endpoint
          BUCKET: dataIngestionBucket.bucketName,
          REGION: this.region,
        },
        functionName: `${id}-DeleteDocumentFunc`,
        layers: [psycopgLayer, powertoolsLayer],
      }
    );

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfndeleteDocument = deleteDocument.node
      .defaultChild as lambda.CfnFunction;
    cfndeleteDocument.overrideLogicalId("DeleteDocumentFunc");

    // Grant the Lambda function the necessary permissions
    dataIngestionBucket.grantDelete(deleteDocument);

    // Grant access to Secret Manager
    deleteDocument.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    // Add the permission to the Lambda function's policy to allow API Gateway access
    deleteDocument.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });

    /**
     * Create Lambda function to get messages for a session
     */
    const getMessagesFunction = new lambda.Function(
      this,
      `${id}-GetMessagesFunction`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/getMessages"), // Update the path to match your folder structure
        handler: "getMessagesFunction.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 128,
        vpc: vpcStack.vpc, // Ensure it's in the correct VPC if needed
        environment: {
          TABLE_NAME: "DynamoDB-Conversation-Table", // Use the correct DynamoDB table name
          REGION: this.region,
        },
        functionName: `${id}-GetMessagesFunction`,
        layers: [psycopgLayer, powertoolsLayer], // Add layers if needed
        role: coglambdaRole, // Ensure the role has the necessary permissions for DynamoDB
      }
    );

    // Add the necessary permissions to the coglambdaRole
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:ListTables", // Allow listing of all DynamoDB tables
          "dynamodb:Query", // Allow querying on specific table
        ],
        resources: ["*"], // Set to "*" as ListTables does not support table-specific ARNs
      })
    );

    // Attach an additional policy that allows querying on the specific DynamoDB table
    coglambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/DynamoDB-Conversation-Table`,
        ],
      })
    );

    // Override the Logical ID if needed
    const cfnGetMessagesFunction = getMessagesFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnGetMessagesFunction.overrideLogicalId("GetMessagesFunction");

    getMessagesFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/DynamoDB-Conversation-Table`,
        ],
      })
    );

    const getMessagesIntegration = new apigateway.LambdaIntegration(
      getMessagesFunction,
      {
        requestTemplates: { "application/json": '{ "statusCode": "200" }' },
      }
    );

    const getMessagesResource = this.api.root.addResource(
      "conversation_messages"
    );
    getMessagesResource.addMethod("GET", getMessagesIntegration, {
      requestParameters: {
        "method.request.querystring.session_id": true,
      },
      authorizationType: apigateway.AuthorizationType.IAM, // Adjust if you use a different auth mechanism
    });

    getMessagesFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/conversation_messages`,
    });

    getMessagesFunction.addPermission("AllowApiGatewayInvokeUser", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/get_messages`,
    });

    /**
     *
     * Create Lambda function to delete an entire module directory
     */
    const deleteCategoryFunction = new lambda.Function(
      this,
      `${id}-DeleteCategoryFunc`,
      {
        runtime: lambda.Runtime.PYTHON_3_9,
        code: lambda.Code.fromAsset("lambda/deleteCategory"),
        handler: "deleteCategory.lambda_handler",
        timeout: Duration.seconds(300),
        memorySize: 128,
        vpc: vpcStack.vpc,
        environment: {
          SM_DB_CREDENTIALS: db.secretPathUser.secretName, // Database User Credentials
          RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint, // RDS Proxy Endpoint
          BUCKET: dataIngestionBucket.bucketName,
          REGION: this.region,
        },
        functionName: `${id}-DeleteCategoryFunc`,
        layers: [psycopgLayer, powertoolsLayer],
      }
    );

    //Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnDeleteCategoryFunction = deleteCategoryFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnDeleteCategoryFunction.overrideLogicalId("DeleteCategoryFunc");

    //Grant the Lambda function the necessary permissions
    dataIngestionBucket.grantRead(deleteCategoryFunction);
    dataIngestionBucket.grantDelete(deleteCategoryFunction);

    deleteCategoryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          //Secrets Manager
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
        ],
      })
    );

    dataIngestionBucket.grantRead(dataIngestFunction);
    // Add ListBucket permission explicitly
    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [dataIngestionBucket.bucketArn], // Access to the specific bucket
      })
    );
    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [
          `arn:aws:s3:::${embeddingStorageBucket.bucketArn}/*`, // Grant access to all objects within this bucket
        ],
      })
    );

    dataIngestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `arn:aws:s3:::${embeddingStorageBucket.bucketName}/*`, // Grant access to all objects within this bucket
        ],
      })
    );

    //Add the permission to the Lambda function's policy to allow API Gateway access
    deleteCategoryFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });
    // Create the rate limiting rule for AppSync
    const rateLimitRule = {
      name: "RateLimitRule",
      priority: 1,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 100, // Adjust the request limit per 5 minutes as needed
          aggregateKeyType: "IP",
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "RateLimitRule",
      },
    };

    const appSyncWebACL = new wafv2.CfnWebACL(this, `${id}-AppSyncWaf`, {
      description: "Web ACL for rate limiting AppSync API",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${id}-AppSyncWaf`,
        sampledRequestsEnabled: true,
      },
      rules: [rateLimitRule],
    });

    // Associate the Web ACL with your AppSync API
    new wafv2.CfnWebACLAssociation(this, `${id}-AppSyncWafAssociationEventApi`, {
      resourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.eventApi.apiId}`,
      webAclArn: appSyncWebACL.attrArn,
    });

    new wafv2.CfnWebACLAssociation(this, `${id}-AppSyncWafAssociationDownloadMessagesApi`, {
      resourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.downloadMessagesApi.apiId}`,
      webAclArn: appSyncWebACL.attrArn,
    });

    new wafv2.CfnWebACLAssociation(this, `${id}-AppSyncWafAssociationCompTextGenApi`, {
      resourceArn: `arn:aws:appsync:${this.region}:${this.account}:apis/${this.compTextGenApi.apiId}`,
      webAclArn: appSyncWebACL.attrArn,
    });

    // Waf Firewall
    const waf = new wafv2.CfnWebACL(this, `${id}-waf`, {
      description: "waf for DSA",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "digitalstrategyassistant-firewall",
      },
      rules: [
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet",
          },
        },
        {
          name: "LimitRequests1000",
          priority: 2,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitRequests1000",
          },
        },
      ],
    });
    const wafAssociation = new wafv2.CfnWebACLAssociation(
      this,
      `${id}-waf-association`,
      {
        resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
        webAclArn: waf.attrArn,
      }
    );


    /**
     *
     * Create Lambda function that will return all the chatlog file names with their respective presigned URLs for a specified course and instructor
     */
    const getChatLogsFunction = new lambda.Function(this, `${id}-GetChatLogsFunction`, {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset("lambda/getChatLogsFunction"),
      handler: "getChatLogsFunction.lambda_handler",
      timeout: Duration.seconds(300),
      memorySize: 256,
      vpc: vpcStack.vpc,
      environment: {
        BUCKET: csv_bucket.bucketName,
        REGION: this.region,
      },
      functionName: `${id}-GetChatLogsFunction`,
      layers: [psycopgLayer, powertoolsLayer],
    });

    // Override the Logical ID of the Lambda Function to get ARN in OpenAPI
    const cfnGetChatLogsFunction = getChatLogsFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnGetChatLogsFunction.overrideLogicalId("GetChatLogsFunction");

    // Grant the Lambda function read-only permissions to the S3 bucket
    csv_bucket.grantRead(getChatLogsFunction);

    // Add the permission to the Lambda function's policy to allow API Gateway access
    getChatLogsFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.api.restApiId}/*/*/admin*`,
    });
  }
}
