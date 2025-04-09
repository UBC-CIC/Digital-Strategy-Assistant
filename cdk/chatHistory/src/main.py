import os
import csv
import json
import boto3
import logging
import re
import psycopg2
import time
import requests, zipfile
from requests_aws4auth import AWS4Auth
import zipfile
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key

aws_region = os.environ.get("REGION")
S3_BUCKET = os.environ.get("CHATLOGS_BUCKET")
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")
TABLE_NAME = os.environ.get("TABLE_NAME")
APPSYNC_API_URL = os.environ.get("APPSYNC_API_URL")

if not TABLE_NAME:
    raise ValueError("TABLE_NAME environment variable is required but not set.")

# Initialize AWS Clients
session_boto = boto3.Session()
credentials = session_boto.get_credentials().get_frozen_credentials()
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
s3_client = boto3.client("s3")
secrets_manager_client = boto3.client("secretsmanager")

# Create AWS4Auth instance for the AppSync service
aws_auth = AWS4Auth(
    credentials.access_key,
    credentials.secret_key,
    aws_region,
    'appsync',
    session_token=credentials.token
)

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()

db_secret = None
connection = None

def get_secret(secret_name):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)
            db_secret = json.loads(response["SecretString"])
        except Exception as e:
            print(f"Error fetching secret: {e}")
            raise
    return db_secret


def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            secret = get_secret(DB_SECRET_NAME)
            print("Connecting to database...")
            connection = psycopg2.connect(
                dbname=secret["dbname"],
                user=secret["username"],
                password=secret["password"],
                host=RDS_PROXY_ENDPOINT,
                port=secret["port"],
            )
        except Exception as e:
            print(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def update_conversation_csv(session_id):
    """ Inserts a record into the conversation_csv table """
    query = """
        INSERT INTO conversation_csv (session_id, notified, timestamp)
        VALUES (%s, %s, %s)
    """
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute(query, (session_id, False, datetime.now(timezone.utc)))
        connection.commit()
        cur.close()
        print(f" Successfully inserted CSV record for session {session_id}")
    except Exception as e:
        print(f" Database error while updating conversation_csv: {e}")
    
def fetch_all_session_ids():
    query = "SELECT DISTINCT session_id FROM user_engagement_log WHERE session_id IS NOT NULL;"
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        print("Fetching session IDs from database...")
        cur.execute(query)
        session_ids = [row[0] for row in cur.fetchall()]
        cur.close()
        print(f"Fetched {len(session_ids)} session IDs.")
        return session_ids
    except Exception as e:
        print(f"Database error: {e}")
        return []


def fetch_all_user_messages():
    """ Fetch user messages along with timestamps and user roles for all sessions. """
    query = """
        SELECT session_id, engagement_details AS user_message, timestamp, user_role
        FROM user_engagement_log
        WHERE engagement_type = 'message creation'
        ORDER BY session_id, timestamp ASC;
    """
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        print("Fetching user messages with timestamps and roles for all sessions...")
        cur.execute(query)
        rows = cur.fetchall()
        cur.close()

        structured_messages = {}
        for session_id, message, timestamp, user_role in rows:
            message = message.strip()
            
            if session_id not in structured_messages:
                structured_messages[session_id] = {}

            structured_messages[session_id][message] = {
                "Timestamp": timestamp,
                "UserRole": user_role  # Directly use user_role without mapping
            }
        
        print(f" Successfully fetched timestamps and user roles for {len(structured_messages)} sessions.")
        return structured_messages

    except Exception as e:
        print(f" Database error while fetching user messages: {e}")
        return {}


def extract_content_and_questions(content):
    """
    Extracts main content and options (questions) from a content string.
    """
    match = re.search(r"(.*)You might have the following questions:(.*)", content, re.DOTALL)
    
    if match:
        main_content = match.group(1).strip()  # Content before the questions section
        questions_text = match.group(2).strip()  # Text containing the questions
    else:
        main_content = content.strip()  # If no questions section, return full content
        questions_text = ""
    
    # Remove all newline characters
    questions_text = questions_text.replace('\n', '')
    
    # Split the questions based on question marks followed by optional whitespace and the end of a question
    questions = re.split(r'\?\s*(?=\S|$)', questions_text)
    
    # Clean up each question, add question marks back, and filter out any empty strings
    questions = [question.strip() + '?' for question in questions if question.strip()]
    
    return main_content, questions

def clean_human_content(content):
    """
    Removes unwanted prefixes like 'user\n' from human message content.
    """
    # Check for 'user' at the start of the content and remove it if present
    lines = content.splitlines()
    # Filter out any line that just says "user" or any similar prefix
    cleaned_lines = [line.strip() for line in lines if line.strip().lower() != "user"]
    return " ".join(cleaned_lines).strip()

def safe_parse_timestamp(timestamp):
    """Convert string timestamp to datetime safely."""

    if isinstance(timestamp, datetime):
        return timestamp  # Already a datetime object

    if not timestamp:  # Handle None, empty strings, or missing timestamps
        return None

    if isinstance(timestamp, int):  # If timestamp is an epoch int, convert it
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)  # Use timezone-aware UTC

    if not isinstance(timestamp, str):
        return None  # Ignore non-string, non-integer values

    try:
        return datetime.fromisoformat(timestamp)  # Try ISO format
    except ValueError:
        try:
            return datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S")  # Fallback format
        except ValueError:
            return None  # If it still fails, return None

def fetch_chat_messages(session_id, table):
    """Fetch user & AI messages from DynamoDB for a given session_id."""
    try:
        logger.info(f"Fetching messages for session {session_id}")

        response = table.query(KeyConditionExpression=Key("SessionId").eq(session_id))

        formatted_messages = []
        
        for item in response["Items"]:
            history = item.get("History", [])
            
            for entry in history:
                message_type = entry.get("type", "unknown")  # 'human' or 'ai'
                content = entry.get("data", {}).get("content", "").strip()
                
                if not content:
                    continue  # Skip empty messages

                if message_type == "human":
                    content = clean_human_content(content)
                
                main_content, questions = extract_content_and_questions(content)

                formatted_message = {
                    "SessionId": session_id,
                    "MessageType": "ai" if message_type == "ai" else "user",
                    "Message": main_content,
                    "Options": questions,
                    "Timestamp": None,  # Will be updated later
                    "UserRole": ""  # Placeholder, will be updated later
                }

                formatted_messages.append(formatted_message)

        return formatted_messages

    except Exception as e:
        logger.error(f"Error processing messages: {e}")
        return []

def fill_ai_message_timestamps(chat_data):
    """
    For each session, walk through messages in order.
    Whenever we see an AI message with no timestamp, assign it
    the last known user timestamp from that session.
    """
    from collections import defaultdict
    
    # Group messages by session_id
    sessions = defaultdict(list)
    for msg in chat_data:
        sessions[msg["SessionId"]].append(msg)
    
    # For each session, fill AI timestamps
    for session_id, messages in sessions.items():
        # messages should already be in chronological order from your fetch logic
        last_user_ts = None
        for msg in messages:
            if msg["MessageType"] == "user" and msg["Timestamp"]:
                last_user_ts = msg["Timestamp"]
            elif msg["MessageType"] == "ai" and msg["Timestamp"] is None and last_user_ts is not None:
                # Assign the AI message the last user's timestamp
                msg["Timestamp"] = last_user_ts
    
    # Flatten back into a single list
    updated_data = []
    for msgs in sessions.values():
        updated_data.extend(msgs)
    
    return updated_data


def write_split_csv(session_id, data):
    """
    Writes CSV files split by month and by maximum file size (25MB).
    - AI messages are assigned the last user timestamp so they don't go to "unknown".
    - If only one part is generated for a month, we name it YYYY-MM.csv (no "_part1").
    - If multiple parts are needed, we name them YYYY-MM_part1.csv, YYYY-MM_part2.csv, etc.
    """
    # 1) Ensure AI messages have timestamps
    data = fill_ai_message_timestamps(data)

    MAX_SIZE = 25 * 1024 * 1024  # 25 MB
    header = ["SessionId", "UserRole", "MessageType", "Message", "Timestamp"]

    # 2) Group by month
    from collections import defaultdict
    groups = defaultdict(list)
    for row in data:
        ts = row["Timestamp"]
        if ts is None:
            # If there's STILL no timestamp (AI before user?), either skip or pick fallback
            continue
        month_key = ts.strftime("%Y-%m")
        groups[month_key].append(row)

    generated_files = []

    for month_key, rows in groups.items():
        # Sort rows in ascending chronological order
        rows.sort(key=lambda r: r["Timestamp"])

        # We'll track how many parts we've actually created
        part = 1

        # Start by writing to a "part1.csv" local file
        local_path = f"/tmp/{session_id}_{month_key}_part{part}.csv"
        
        try:
            with open(local_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(header)

                for row_data in rows:
                    ts = row_data["Timestamp"]
                    formatted_ts = ts.strftime("%Y-%m-%d %H:%M:%S")
                    writer.writerow([
                        row_data["SessionId"],
                        row_data["UserRole"],
                        row_data["MessageType"],
                        row_data["Message"],
                        formatted_ts
                    ])
                    f.flush()

                    # If file exceeds 25MB, upload and start a new part
                    if os.path.getsize(local_path) >= MAX_SIZE:
                        # Close this part and upload it
                        f.close()

                        # If part == 1, we keep it named "_part1.csv"
                        part_s3_key = f"{session_id}/csv_parts/{month_key}_part{part}.csv"
                        s3_client.upload_file(local_path, S3_BUCKET, part_s3_key)
                        generated_files.append((local_path, part_s3_key))

                        # Move on to next part
                        part += 1
                        local_path = f"/tmp/{session_id}_{month_key}_part{part}.csv"
                        
                        # Open new part with enhanced file handling
                        try:
                            f = open(local_path, "w", newline="", encoding="utf-8")
                            writer = csv.writer(f)
                            writer.writerow(header)
                        except IOError as io_err:
                            logger.error(f"Error creating new CSV part: {io_err}")
                            raise

        except IOError as io_err:
            logger.error(f"Error writing CSV file for {month_key}: {io_err}")
            raise
        finally:
            # Ensure the file is closed if it's still open
            if 'f' in locals() and not f.closed:
                f.close()

        # Handling the final part of each month
        if part == 1:
            # Means we never created a second part => rename to just {month_key}.csv
            final_local_path = f"/tmp/{session_id}_{month_key}.csv"
            os.rename(local_path, final_local_path)  # e.g. rename ..._part1.csv to ... .csv

            final_s3_key = f"{session_id}/csv_parts/{month_key}.csv"
            s3_client.upload_file(final_local_path, S3_BUCKET, final_s3_key)
            generated_files.append((final_local_path, final_s3_key))
        else:
            # We actually had multiple parts => the last file remains e.g. _part{part}.csv
            final_local_path = local_path  # It's already named _part{part}.csv
            final_s3_key = f"{session_id}/csv_parts/{month_key}_part{part}.csv"
            s3_client.upload_file(final_local_path, S3_BUCKET, final_s3_key)
            generated_files.append((final_local_path, final_s3_key))

    return generated_files


def create_zip_for_session(session_id, csv_files):
    """
    Bundle all CSV files for the given session_id into a single zip archive,
    store it as: s3://{S3_BUCKET}/{session_id}/{timestamp}_chatlogs.zip
    """
    # Generate a timestamp string for the file name
    timestamp_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    zip_filename = f"{timestamp_str}_chatlogs.zip"
    zip_local_path = f"/tmp/{zip_filename}"
    
    with zipfile.ZipFile(zip_local_path, 'w') as zipf:
        for local_path, s3_key in csv_files:
            arcname = os.path.basename(s3_key)  # e.g. "2025-03_part1.csv"
            zipf.write(local_path, arcname=arcname)

    zip_s3_key = f"{session_id}/{zip_filename}"  # e.g. "session_id/2025-03-20_12-45-00_chatlogs.zip"
    s3_client.upload_file(zip_local_path, S3_BUCKET, zip_s3_key)

    return zip_s3_key


def invoke_event_notification(session_id, message):
    """
    Publish a notification event to AppSync using AWS_IAM authentication.
    This implementation uses requests with requests-aws4auth to sign the request via SigV4.
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
        payload = {
            "query": query,
            "variables": {
                "message": message,
                "sessionId": session_id
            }
        }
        headers = {
            "Content-Type": "application/json"
        }


        # Send the request to AppSync with the AWS4Auth signing.
        response = requests.post(APPSYNC_API_URL, auth=aws_auth, headers=headers, json=payload)
        response_data = response.json()

        logger.info(f"AppSync Response: {json.dumps(response_data, indent=2)}")
        if response.status_code != 200 or "errors" in response_data:
            raise Exception(f"Failed to send notification: {response_data}")

        print(f"Notification sent successfully: {response_data}")
        return response_data["data"]["sendNotification"]

    except Exception as e:
        logger.error(f"Error publishing event to AppSync: {str(e)}")
        raise

def handler(event, context):
    """
    Updated Lambda handler to:
      - Fetch all chat data,
      - Fill in AI message timestamps (using the last user timestamp) so that they are grouped with user messages,
      - Write CSV files split by month and file size,
      - Bundle them into a zip file,
      - Upload to S3 and notify via AppSync.
    """
    for record in event["Records"]:
        try:
            message_body = json.loads(record["body"])
            current_session_id = message_body.get("session_id")
            
            print("🔍 Fetching all user message timestamps and roles...")
            user_timestamps = fetch_all_user_messages()
            
            print("🔍 Fetching all session IDs...")
            session_ids = fetch_all_session_ids()

            chat_data = []
            for session_id in session_ids:
                chat_messages = fetch_chat_messages(session_id, table)
                session_timestamps = user_timestamps.get(session_id, {})
                for message in chat_messages:
                    if message["MessageType"] == "user":
                        user_data = session_timestamps.get(message["Message"], {})
                        message["Timestamp"] = user_data.get("Timestamp", None)
                        message["UserRole"] = user_data.get("UserRole", "")
                    # For AI messages, do not override the timestamp here (it will be fixed later)
                    chat_data.append(message)
            
            # NEW: Update AI messages with the last user timestamp so they are grouped in the proper month.
            chat_data = fill_ai_message_timestamps(chat_data)
            
            print("Merging complete. Writing split CSV files...")
            csv_files = write_split_csv(current_session_id, chat_data)
            print("Creating zip archive for the session...")
            zip_s3_key = create_zip_for_session(current_session_id, csv_files)
            
            print(f"Zip archive created and uploaded: s3://{S3_BUCKET}/{zip_s3_key}")
            invoke_event_notification(current_session_id, message="Chat logs zip available in S3")
            
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "message": "CSV files split and zipped successfully",
                    "zip_s3_path": f"s3://{S3_BUCKET}/{zip_s3_key}"
                })
            }
        except Exception as e:
            print(f"Lambda Error: {e}")
            return {
                "statusCode": 500,
                "body": json.dumps({"error": "Internal Server Error"})
            }
