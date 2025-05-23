import os
import json
import boto3
import logging
import time
import psycopg2
import httpx
import uuid, datetime
from langchain_aws import BedrockEmbeddings
from helpers.vectorstore import get_vectorstore_retriever_ordinary
from helpers.chat import get_bedrock_llm, get_response_evaluation

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()
APPSYNC_API_URL = os.environ["APPSYNC_API_URL"]
COMP_TEXT_GEN_QUEUE_URL = os.environ["COMP_TEXT_GEN_QUEUE_URL"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
DB_COMP_SECRET_NAME = os.environ["SM_DB_COMP_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
RDS_PROXY_COMP_ENDPOINT = os.environ["RDS_PROXY_COMP_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
EMBEDDING_MODEL_PARAM = os.environ["EMBEDDING_MODEL_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
API_KEY = os.environ["API_KEY"]
# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
# Cached resources
connection = None
connection_comparison = None
db_secret = None
db_secret_comparison = None
BEDROCK_LLM_ID = None
EMBEDDING_MODEL_ID = None
TABLE_NAME = None
# Cached embeddings instance
embeddings = None

def invoke_event_notification(session_id, message):
    """
    Publish a notification event to AppSync via HTTPX (directly to the AppSync API).
    """
    try:
        query = """
        mutation sendNotification($message: String!, $sessionId: String!) {
            sendNotification(message: $message, sessionId: $sessionId) {
                message
                sessionId
            }
        }
        """
        headers = {
            "Content-Type": "application/json",
            "Authorization": API_KEY
        }

        payload = {
            "query": query,
            "variables": {
                "message": message,
                "sessionId": session_id
            }
        }
        time.sleep(1)
        # Send the request to AppSync
        with httpx.Client() as client:
            response = client.post(APPSYNC_API_URL, headers=headers, json=payload)
            response_data = response.json()

            logging.info(f"AppSync Response: {json.dumps(response_data, indent=2)}")
            if response.status_code != 200 or "errors" in response_data:
                raise Exception(f"Failed to send notification: {response_data}")

            
            return response_data["data"]["sendNotification"]

    except Exception as e:
        logging.error(f"Error publishing event to AppSync: {str(e)}")
        raise

def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret: {e}")
            raise ValueError(f"Secret  is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret : {e}")
            raise
    return db_secret

def get_secret_comparison(secret_name, expect_json=True):
    global db_secret_comparison
    if db_secret_comparison is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret_comparison = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret : {e}")
            raise ValueError(f"Secret  is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret : {e}")
            raise
    return db_secret_comparison

def get_parameter(param_name, cached_var):
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var


def initialize_constants():
    global BEDROCK_LLM_ID, EMBEDDING_MODEL_ID, TABLE_NAME, embeddings
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    EMBEDDING_MODEL_ID = get_parameter(EMBEDDING_MODEL_PARAM, EMBEDDING_MODEL_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)
    if embeddings is None:
        embeddings = BedrockEmbeddings(
            model_id=EMBEDDING_MODEL_ID,
            client=bedrock_runtime,
            region_name=REGION,
        )
    
    # create_dynamodb_history_table(TABLE_NAME)

def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            secret = get_secret(DB_SECRET_NAME)
            connection_params = {
                'dbname': secret["dbname"],
                'user': secret["username"],
                'password': secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': secret["port"]
            }
            connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
            connection = psycopg2.connect(connection_string)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def connect_to_comparison_db():
    global connection_comparison
    if connection_comparison is None or connection_comparison.closed:
        try:
            secret = get_secret_comparison(DB_COMP_SECRET_NAME)
            connection_params = {
                'dbname': secret["dbname"],
                'user': secret["username"],
                'password': secret["password"],
                'host': RDS_PROXY_COMP_ENDPOINT,
                'port': secret["port"]
            }
            connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
            connection_comparison = psycopg2.connect(connection_string)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection_comparison:
                connection_comparison.rollback()
                connection_comparison.close()
            raise
    return connection_comparison

def get_combined_guidelines(criteria_list):
    """
    Fetch and organize headers and bodies of all guidelines matching the given criteria names.

    Args:
        criteria_list (list): A list of criteria names to search for in the guidelines table.

    Returns:
        dict: A dictionary organizing headers and bodies under their respective criteria names.
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {}

    try:
        cur = connection.cursor()

        # Define the SQL query with IN clause
        query = """
        SELECT criteria_name, header, body
        FROM guidelines
        WHERE criteria_name = ANY(%s)
        ORDER BY criteria_name, timestamp DESC;
        """

        # Execute the query with the criteria list as a parameter
        cur.execute(query, (criteria_list,))
        results = cur.fetchall()

        # Organize results into a dictionary
        guidelines_dict = {}
        for criteria_name, header, body in results:
            if criteria_name not in guidelines_dict:
                guidelines_dict[criteria_name] = []
            # Combine header and body in the desired format
            guidelines_dict[criteria_name].append(f"{header}: {body}")

        # Return the dictionary
        return guidelines_dict

    except Exception as e:
        logger.error(f"Error fetching guidelines: {e}")
        return {}

    finally:
        if cur:
            cur.close()
        if connection:
            connection.close()


def handler(event, context):
    time.sleep(1)
    
    initialize_constants()
    user_uploaded_vectorstore = None
    
    for record in event['Records']:
        start_time = time.time()
        message_body = json.loads(record['body'])
        session_id = message_body['session_id']
        user_role = message_body['user_role']
        criteria = message_body['criteria']

        
        try:
            guidelines = get_combined_guidelines(criteria)
            logger.info("Retrieving vectorstore config.")
            db_secret = get_secret_comparison(DB_COMP_SECRET_NAME)
            
            vectorstore_config_dict = {
                'collection_name': session_id,
                'dbname': db_secret["dbname"],
                'user': db_secret["username"],
                'password': db_secret["password"],
                'host': RDS_PROXY_COMP_ENDPOINT,
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
                'body': json.dumps('Error retrieving user uploaded document vectorstore config')
            }
        try:
            logger.info("Creating Bedrock LLM instance.")
            llm = get_bedrock_llm(bedrock_llm_id=BEDROCK_LLM_ID)
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
        # Try obtaining the ordinary retriever given this vectorstore config dict
        try:
            logger.info("Creating ordinary retriever for user uploaded vectorstore.")
            ordinary_retriever, user_uploaded_vectorstore = get_vectorstore_retriever_ordinary(
                vectorstore_config_dict=vectorstore_config_dict,
                embeddings=embeddings
            )
        except Exception as e:
            logger.error(f"Error creating ordinary retriever for user uploaded vectorstore: {e}")
            return {
                'statusCode': 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps('Error creating ordinary retriever for user uploaded vectorstore')
            }

        # Try getting an evaluation result from the LLM
        try:

            all_responses = []
            try:
                last_header = None  # to keep track of the last printed header

                # Process each guideline evaluation individually
                for individual_response in get_response_evaluation(
                    llm=llm,
                    retriever=ordinary_retriever,
                    guidelines_file=guidelines
                ):
                    # Extract the current header from the response (assuming it's stored in "header")
                    current_header = individual_response.get("header")

                    # If there's a header and it differs from the last header, print/notify it once.
                    if current_header and current_header != last_header:
                        header_msg = f"header_center: **{current_header}**"  # formatting header in markdown if needed 
                        invoke_event_notification(session_id, header_msg)
                        
                        last_header = current_header  # update the last printed header

                    
                    # Send immediate notification for each guideline output (excluding header, already sent)
                    invoke_event_notification(session_id, individual_response["llm_output"])
                    
                    # Store for final response
                    all_responses.append(individual_response)


            except Exception as e:
                # Handle per-guideline errors without stopping
                error_msg = {
                    "llm_output": f"🚨 Processing error: {str(e)}",
                    "options": []
                }
                invoke_event_notification(session_id, error_msg["llm_output"])
                all_responses.append(error_msg)

            finally:
                # Always send completion message and clean up
                end_time = time.time()
                duration = end_time - start_time
                time_taken_msg = f"Time taken for evaluation: {duration:.2f} seconds."
                completion_msg = {
                    "llm_output": "EVALUATION_COMPLETE\n\n" + time_taken_msg,
                    "options": []
                }
                invoke_event_notification(session_id, completion_msg)
                
            # Delete the collection from the user_uploaded_vectorstore after the embeddings have been used for evaluation
            if user_uploaded_vectorstore:
                user_uploaded_vectorstore.delete_collection()
                
            else:
                print("User uploaded vector store collection not found! Could not delete it as a result.")
        except Exception as e:
             # Deleting this vectorstore collection if there was an error generating an LLM response.
             user_uploaded_vectorstore.delete_collection()
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
        
        logger.info("Returning the generated evaluation.")

        # This part below might have to be fixed
        # If LLM did generate a response, return it
        return {
            "statusCode": 200,
            "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                },
            "body": json.dumps({
                "type": "ai",
                # "content": response.get("llm_output", "LLM failed to create response"),
                "options": [],
                "user_role": user_role
            })
        }
