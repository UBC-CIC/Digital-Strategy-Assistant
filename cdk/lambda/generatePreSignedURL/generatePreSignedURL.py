import os, json
import boto3
from botocore.config import Config
from aws_lambda_powertools import Logger

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)
logger = Logger()

def s3_key_exists(bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except:
        return False

@logger.inject_lambda_context(log_event=True)
def lambda_handler(event, context):
    # Use .get() to safely extract query string parameters
    query_params = event.get("queryStringParameters", {})

    if not query_params:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing queries to generate pre-signed URL')
        }

    # course_id = query_params.get("course_id", "")
    category_id = query_params.get("category_id", "")
    document_type = query_params.get("document_type", "")
    document_name = query_params.get("document_name", "")

    if not category_id:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: category_id')
        }
    
    if not document_name:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: document_name')
        }

    # Allowed file types for documents with their corresponding MIME types
    allowed_document_types = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xps": "application/oxps",  # or "application/vnd.ms-xpsdocument" for legacy XPS
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip"
    }
    
    if document_type in allowed_document_types:
        key = f"{category_id}/{document_name}.{document_type}"
        content_type = allowed_document_types[document_type]
    else:
        return {
            'statusCode': 400,
            'body': json.dumps('Unsupported file type')
        }

    logger.info({
        "category": category_id,
        "document_type": document_type,
        "document_name": document_name,
    })

    try:

        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=300,
            HttpMethod="PUT",
        )

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
            },
            "body": json.dumps({"presignedurl": presigned_url}),
        }
    
    except Exception as e:
        logger.error(f"Error generating presigned URL or uploading txt file: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps('Internal server error')
        }