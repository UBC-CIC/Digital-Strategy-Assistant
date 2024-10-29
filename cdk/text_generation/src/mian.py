import os
import json
import boto3
import logging
import psycopg2
import boto3
from langchain_aws import BedrockEmbeddings


from helpers.vectorstore import get_vectorstore_retriever
from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, create_dynamodb_history_table, get_response, update_session_name

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()


DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]

def get_secret(secret_name, expect_json=True):
    try:
        # secretsmanager client to get db credentials
        sm_client = boto3.client("secretsmanager")
        response = sm_client.get_secret_value(SecretId=secret_name)["SecretString"]
        
        if expect_json:
            return json.loads(response)
        else:
            print(response)
            return response
    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode JSON for secret {secret_name}: {e}")
        raise ValueError(f"Secret {secret_name} is not properly formatted as JSON.")
    except Exception as e:
        logger.error(f"Error fetching secret {secret_name}: {e}")
        raise


    

## GET SECRET VALUES FOR CONSTANTS
BEDROCK_LLM_ID = get_secret(os.environ["BEDROCK_LLM_SECRET"], expect_json=False)
EMBEDDING_MODEL_ID = get_secret(os.environ["EMBEDDING_MODEL_SECRET"], expect_json=False)
TABLE_NAME = get_secret(os.environ["TABLE_NAME_SECRET"], expect_json=False)
                        
## GETTING AMAZON TITAN EMBEDDINGS MODEL
bedrock_runtime = boto3.client(
        service_name="bedrock-runtime",
        region_name=REGION,
    )

embeddings = BedrockEmbeddings(
    model_id=EMBEDDING_MODEL_ID, 
    client=bedrock_runtime,
    region_name=REGION
)

create_dynamodb_history_table(TABLE_NAME)

# def get_module_name(category_id):
#     connection = None
#     cur = None
#     try:
#         logger.info(f"Fetching module name for module_id: {module_id}")
#         db_secret = get_secret(DB_SECRET_NAME)
#         connection_params = {
#             'dbname': db_secret["dbname"],
#             'user': db_secret["username"],
#             'password': db_secret["password"],
#             'host': db_secret["host"],
#             'port': db_secret["port"]
#         }

#         connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])

#         connection = psycopg2.connect(connection_string)
#         cur = connection.cursor()
#         logger.info("Connected to RDS instance!")

#         cur.execute("""
#             SELECT module_name 
#             FROM "Course_Modules" 
#             WHERE module_id = %s;
#         """, (module_id,))
        
#         result = cur.fetchone()
#         logger.info(f"Query result: {result}")
#         module_name = result[0] if result else None
        
#         cur.close()
#         connection.close()
        
#         if module_name:
#             logger.info(f"Module name for module_id {module_id} found: {module_name}")
#         else:
#             logger.warning(f"No module name found for module_id {module_id}")
        
#         return module_name

    # except Exception as e:
    #     logger.error(f"Error fetching module name: {e}")
    #     if connection:
    #         connection.rollback()
    #     return None
    # finally:
    #     if cur:
    #         cur.close()
    #     if connection:
    #         connection.close()
    #     logger.info("Connection closed.")

def get_system_prompt(prompt_id):
    # connection = None
    # cur = None
    # try:
    #     logger.info(f"Fetching system prompt for user: {prompt_id}")
    #     db_secret = get_secret(DB_SECRET_NAME)

    #     connection_params = {
    #         'dbname': db_secret["dbname"],
    #         'user': db_secret["username"],
    #         'password': db_secret["password"],
    #         'host': db_secret["host"],
    #         'port': db_secret["port"]
    #     }

        # connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])

        # connection = psycopg2.connect(connection_string)
        # cur = connection.cursor()
        # logger.info("Connected to RDS instance!")

        # cur.execute("""
        #     SELECT system_prompt 
        #     FROM "Courses" 
        #     WHERE course_id = %s;
        # """, (course_id,))
        
        # result = cur.fetchone()
        # logger.info(f"Query result: {result}")
        # system_prompt = result[0] if result else None
        
        # cur.close()
        # connection.close()
        
        # if system_prompt:
        #     logger.info(f"System prompt for course_id {course_id} found: {system_prompt}")
        # else:
        #     logger.warning(f"No system prompt found for course_id {course_id}")
        if prompt_id == "user":
            system_prompt = """You are an AI assistant for a program called Digital Learning Strategy by the Government of British Columbia. 
                        Here is a link to that website: "https://www2.gov.bc.ca/gov/content/education-training/post-secondary-education/institution-resources-administration/digital-learning-strategy".
                        Your job is to help the different types of users. Different types of users include: Student, prospective student, educator, educational designer, Post-secondary institution administrator, Post-secondary institution leader. 
                        """
        
        elif prompt_id == "educator":
            system_prompt = """
                You are an AI assistant for a program called Digital Learning Strategy by the Government of British Columbia. 
                        Here is a link to that website: "https://www2.gov.bc.ca/gov/content/education-training/post-secondary-education/institution-resources-administration/digital-learning-strategy".
                        Your job is to help the different types of users. Different types of users include: Student, prospective student, educator, educational designer, Post-secondary institution administrator, Post-secondary institution leader.
        """
        elif prompt_id == "admin":
            system_prompt = """
                You are an AI assistant for a program called Digital Learning Strategy by the Government of British Columbia. 
                        Here is a link to that website: "https://www2.gov.bc.ca/gov/content/education-training/post-secondary-education/institution-resources-administration/digital-learning-strategy".
                        Your job is to help the different types of users. Different types of users include: Student, prospective student, educator, educational designer, Post-secondary institution administrator, Post-secondary institution leader.
        """
        return system_prompt

    # except Exception as e:
    #     logger.error(f"Error fetching system prompt: {e}")
    #     if connection:
    #         connection.rollback()
    #     return None
    # finally:
    #     if cur:
    #         cur.close()
    #     if connection:
    #         connection.close()
    #     logger.info("Connection closed.")

def handler(event, context):
    logger.info("Text Generation Lambda function is called!")

    query_params = event.get("queryStringParameters", {})
    prompt_id = "user"
    category_id = query_params.get("category_id", "")
    session_id = query_params.get("session_id", "")
    session_name = query_params.get("session_name")

    if not category_id:
        logger.error("Missing required parameter: category_id")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameter: category_id')
        }

    if not session_id:
        logger.error("Missing required parameter: session_id")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Missing required parameter: session_id')
        }

    # if not module_id:
    #     logger.error("Missing required parameter: module_id")
    #     return {
    #         'statusCode': 400,
    #         "headers": {
    #             "Content-Type": "application/json",
    #             "Access-Control-Allow-Headers": "*",
    #             "Access-Control-Allow-Origin": "*",
    #             "Access-Control-Allow-Methods": "*",
    #         },
    #         'body': json.dumps('Missing required parameter: module_id')
    #     }
    
    
    system_prompt = get_system_prompt(prompt_id)

    if system_prompt is None:
        logger.error(f"Error fetching system prompt for you!")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error fetching system prompt')
        }
    
    # topic = "ABC"

    # if topic is None:
    #     logger.error(f"Invalid module_id: {module_id}")
    #     return {
    #         'statusCode': 400,
    #         'body': json.dumps('Invalid module_id')
    #     }
    
    body = {} if event.get("body") is None else json.loads(event.get("body"))
    question = body.get("message_content", "")
    
    if not question:
        logger.info(f"Start of conversation. Creating conversation history table in DynamoDB.")
        student_query = get_initial_student_query()
    else:
        logger.info(f"Processing student question: {question}")
        student_query = get_student_query(question)
    
    try:
        logger.info("Creating Bedrock LLM instance.")
        llm = get_bedrock_llm(BEDROCK_LLM_ID)
    except Exception as e:
        logger.error(f"Error getting LLM from Bedrock: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error getting LLM from Bedrock')
        }
    
    try:
        logger.info("Retrieving vectorstore config.")
        db_secret = get_secret(DB_SECRET_NAME)
        vectorstore_config_dict = {
            'collection_name': category_id,
            'dbname': db_secret["dbname"],
            'user': db_secret["username"],
            'password': db_secret["password"],
            'host': db_secret["host"],
            'port': db_secret["port"]
        }
    except Exception as e:
        logger.error(f"Error retrieving vectorstore config: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error retrieving vectorstore config')
        }
    
    try:
        logger.info("Creating history-aware retriever.")

        history_aware_retriever = get_vectorstore_retriever(
            llm=llm,
            vectorstore_config_dict=vectorstore_config_dict,
            embeddings=embeddings
        )
    except Exception as e:
        logger.error(f"Error creating history-aware retriever: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error creating history-aware retriever')
        }
    
    try:
        logger.info("Generating response from the LLM.")
        response = get_response(
            query=student_query,
            llm=llm,
            history_aware_retriever=history_aware_retriever,
            table_name=TABLE_NAME,
            session_id=session_id,
            course_system_prompt=system_prompt
        )
    except Exception as e:
        logger.error(f"Error getting response: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error getting response')
        }
    
    try:
        logger.info("Updating session name if this is the first exchange between the LLM and student")
        potential_session_name = update_session_name(TABLE_NAME, session_id, BEDROCK_LLM_ID)
        if potential_session_name:
            logger.info("This is the first exchange between the LLM and student. Updating session name.")
            session_name = potential_session_name
        else:
            logger.info("Not the first exchange between the LLM and student. Session name remains the same.")
    except Exception as e:
        logger.error(f"Error updating session name: {e}")
        session_name = "New Chat"
    
    logger.info("Returning the generated response.")
    return {
        "statusCode": 200,
        "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
        "body": json.dumps({
            "session_name": session_name,
            "llm_output": response.get("llm_output", "LLM failed to create response"),
            "llm_verdict": response.get("llm_verdict", "LLM failed to create verdict")
        })
    }