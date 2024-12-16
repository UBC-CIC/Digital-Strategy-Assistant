# import json
# import os
# import requests

# def lambda_handler(event, context):
#     try:
#         session_id = event.get('sessionId')
#         if not session_id:
#             return {
#                 "statusCode": 400,
#                 "body": json.dumps("Missing sessionId in the event payload.")
#             }
        
#         message = event.get('message', "Embeddings created successfully")
        
#         url = f"https://{os.environ['APPSYNC_API_ID']}.appsync-api.{os.envirokkkn['REGION']}.amazonaws.com/graphql"
#         headers = {
#             "Content-Type": "application/json",
#             "x-api-key": os.environ["APPSYNC_API_KEY"],
#         }
#         payload = {
#             "query": """
#                 mutation sendNotification($message: String!, $sessionId: String!) {
#                     sendNotification(message: $message, sessionId: $sessionId) {
#                         message
#                         sessionId
#                     }
#                 }
#             """,
#             "variables": {
#                 "message": message,
#                 "sessionId": session_id,
#             },
#         }

#         response = requests.post(url, headers=headers, json=payload)
#         response_json = response.json()

#         # if response.status_code != 200 or "errors" in response.json():
#         #     raise Exception(f"Error publishing event: {response.json()}")
#         if response.status_code != 200 or "errors" in response_json:
#             return {
#                 'statusCode': response.status_code,
#                 'body': json.dumps({
#                     "error": response_json.get("errors", "Unknown error"),
#                     "details": response_json
#                 })
#             }

#         return {
#             'statusCode': 200,
#             'body': json.dumps({
#                 "message": "Event published successfully.",
#                 "response": response_json
#             })
#         }
#     except Exception as e:
#         return {
#             'statusCode': 500,
#             'body': json.dumps({
#                 "error": str(e)
#             })
#         }
import json
import os
import urllib.request

APPSYNC_API_URL = os.environ["APPSYNC_API_URL"]

def lambda_handler(event, context):
    # try:
    #     session_id = event.get('sessionId')
    #     if not session_id:
    #         return {
    #             "statusCode": 400,
    #             "body": json.dumps("Missing sessionId in the event payload.")
    #         }
        
    #     message = event.get('message', "Embeddings created successfully")
        
    #     url = f"{APPSYNC_API_URL}"
    #     headers = {
    #         "Content-Type": "application/json",
    #         "x-api-key": os.environ["APPSYNC_API_KEY"],
    #     }
    #     payload = {
    #         "query": """
    #             mutation sendNotification($message: String!, $sessionId: String!) {
    #                 sendNotification(message: $message, sessionId: $sessionId) {
    #                     message
    #                     sessionId
    #                 }
    #             }
    #         """,
    #         "variables": {
    #             "message": message,
    #             "sessionId": session_id,
    #         },
    #     }

    #     # Prepare the request
    #     data = json.dumps(payload).encode('utf-8')
    #     req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        
    #     # Execute the request
    #     with urllib.request.urlopen(req) as response:
    #         response_data = response.read().decode('utf-8')
    #         response_json = json.loads(response_data)

    #     # Handle errors or return success
    #     if "errors" in response_json:
    #         return {
    #             'statusCode': 400,
    #             'body': json.dumps({
    #                 "error": response_json.get("errors", "Unknown error"),
    #                 "details": response_json
    #             })
    #         }

    #     return {
    #         'statusCode': 200,
    #         'body': json.dumps({
    #             "message": "Event published successfully.",
    #             "response": response_json
    #         })
    #     }
    # except Exception as e:
    #     return {
    #         'statusCode': 500,
    #         'body': json.dumps({
    #             "error": str(e),
    #         "url": url
    #         })
    #     }
    #########################################################################3
    # print(f"Event Received: {json.dumps(event)}")
    # try:
    #     # Hardcode response for testing
    #     return {
    #         "statusCode": 200,
    #         "body": json.dumps({
    #             "message": "Test Message",
    #             "sessionId": "TestSessionId"
    #         })
    #     }
    # except Exception as e:
    #     return {
    #         'statusCode': 500,
    #         'body': json.dumps({"error": str(e)})
    #     }
    ###################################working ################################
    # print(f"Event Received: {json.dumps(event)}")
    # try:
    #     # Return a flat JSON object
    #     return {
    #         "message": "Test Message",
    #         "sessionId": "TestSessionId"
    #     }
    # except Exception as e:
    #     return {
    #         'error': str(e)
    #     }
    print(f"Event Received: {json.dumps(event)}")
    try:
        # Process the event to extract the sessionId and message
        session_id = event.get("sessionId", "DefaultSessionId")
        message = event.get("message", "Default message")
        
        # Return the processed data
        return {
            "message": message,
            "sessionId": session_id
        }
    except Exception as e:
        return {
            'error': str(e)
        }