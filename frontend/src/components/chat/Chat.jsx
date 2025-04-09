import React, { useState, useRef, useEffect } from "react";
import Header from "../Header";
import ReactMarkdown from "react-markdown";
import MainMessage from "./MainMessage";
import OptionMessage from "./OptionMessage";
import UserMessage from "./UserMessage";
import "./TypingIndicator.css";
import Footer from "../Footer";
import {
  LuSendHorizonal,
  LuListRestart,
  LuMic,
  LuMicOff,
} from "react-icons/lu";
import { getFingerprint } from "@thumbmarkjs/thumbmarkjs";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import TypingIndicator from "./TypingIndicator";
import FeedbackComponent from "./Feedback";
import SyllabusComparisonModal from "./SyllabusComparison";
import { processAndUploadFiles } from "./Utility";
import { getUserRole } from "./Utility";
import { TbLayersDifference } from "react-icons/tb";

// Function to get credentials for WebSocket connection
async function getWebSocketCredentials() {
  try {
    const session = await fetchAuthSession();
    const credentials = session.credentials;
    return credentials;
  } catch (error) {
    console.error('Error getting credentials:', error);
    return null;
  }
}

// "Processing document..." animation
const TypingIndicatorProcessing = () => (
  <div className="processing-container">
    <span className="processing-text">Processing document...</span>
  </div>
);
const Chat = ({ setPage }) => {
  const [fingerprint, setFingerprint] = useState("");
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [documentProcessing, setDocumentProcessing] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState({ rating: "", description: [] });
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [showSyllabusModal, setShowSyllabusModal] = useState(false);
  const [textSyllabus, setTextSyllabus] = useState("");
  const [syllabusFiles, setSyllabusFiles] = useState([]);
  const [selectedCriteria, setSelectedCriteria] = useState([]);
  const [isEvaluationActive, setIsEvaluationActive] = useState(false);
  const [evaluationComplete, setEvaluationComplete] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const chatContainerRef = useRef(null);

  

  // 1. If autoScroll is true, we scroll down whenever `messages` change
  useEffect(() => {
    if (autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, showFeedback, autoScroll]);
  // 2. On scroll, check if user is near the bottom
  const handleScroll = () => {
    if (!chatContainerRef.current) return;

    const { scrollTop, clientHeight, scrollHeight } = chatContainerRef.current;
    // If scrollTop + clientHeight is near the scrollHeight,
    // we consider the user at the bottom
    const atBottom = scrollTop + clientHeight >= scrollHeight - 10;
    setAutoScroll(atBottom);
  };
    // Additionally, add a useEffect to monitor isLoading changes:
  useEffect(() => {
    
  }, [isLoading]);
  
  useEffect(() => {
    
  }, [isLoading, isCreatingSession, documentProcessing]);

  useEffect(() => {
   
  }, [isCreatingSession]);

  const INITIAL_MESSAGE = {
    Type: "ai",
    Content:
      "Hello! Please select the best role below that fits you. We can better answer your questions. Don't include personal details such as your name and private content.",
    Options: [
      "Student/general public",
      "Educator/educational designer",
      "Post-secondary institution admin/leader",
    ],
    user_role: "",
  };

  const wsRef = useRef(null);

  const handleFeedbackSubmit = async () => {
    if (!feedback.rating || isSendingFeedback) return;

    setIsSendingFeedback(true);

    // Check for feedback fields and set them to null if they don't exist
    const feedbackRating = feedback.rating || null;
    const feedbackDescription = feedback.description?.join(", ") || null;

    try {
      await fetch(
        `${
          process.env.NEXT_PUBLIC_API_ENDPOINT
        }/user/create_feedback?user_info=${encodeURIComponent(
          fingerprint
        )}&session_id=${encodeURIComponent(session)}&user_role=${getUserRole(
          messages
        )}&feedback_rating=${encodeURIComponent(
          feedbackRating
        )}&feedback_description=${encodeURIComponent(feedbackDescription)}`,
        { method: "POST" }
      );
      setMessages([
        ...messages,
        {
          Type: "ai",
          Content:
            "Thank you! Your feedback will help improve the Digital Strategy Assistant. You may continue asking questions or start a new session.",
        },
      ]);
      setShowFeedback(false);
    } catch (error) {
      console.error("Error sending feedback:", error);
      toast.error("Failed to send feedback. Please try again.");
    } finally {
      setIsSendingFeedback(false);
    }
  };


  const constructCompTextGenWebSocketUrl = async () => {
    const tempUrl = process.env.NEXT_PUBLIC_APPSYNC_API_URL;
    const apiUrl = tempUrl.replace("https://", "wss://");
    const urlObj = new URL(apiUrl);
    const tmpObj = new URL(tempUrl);
    const modifiedHost = urlObj.hostname.replace(
      "appsync-api",
      "appsync-realtime-api"
    );
  
    urlObj.hostname = modifiedHost;
    const host = tmpObj.hostname;
    
    // Get credentials from Cognito Identity Pool
    const credentials = await getWebSocketCredentials();
    
    // Only use credentials without fallback to static key
    const header = {
      host: host,
      Authorization: credentials ? `Bearer ${credentials.sessionToken}` : "",
    };
  
    const encodedHeader = btoa(JSON.stringify(header));
    const payload = "e30=";
  
    return `${urlObj.toString()}?header=${encodedHeader}&payload=${payload}`;
  };

  const controllerRef = useRef(null);
  const sendMessage = async (content, isOption = false, isComparison = false) => {
    if (!session || !fingerprint || (!content.trim() && !isOption)) return;
    
    controllerRef.current = new AbortController();
    const signal = controllerRef.current.signal;
    const currentMessages = [...messages];
    const userRole = getUserRole(currentMessages);
  
    if (!isOption && currentMessages.length === 1) {
      toast.error("Please select one of the options first!");
      return;
    }
    // setIsEvaluationActive(true);
    setMessageInput("");
    setIsLoading(true);
  
    try {
      const userMessage = { Type: "human", Content: content };
      setMessages((prev) => [...prev, userMessage]);
  
      // Prepare request body
      const requestBody = isComparison
        ? {
            comparison: true,
            message_content: content,
            user_role: getUserRole([...currentMessages, userMessage]),
            criteria: selectedCriteria,
          }
        : {
            message_content: content,
            user_role: getUserRole([...currentMessages, userMessage]),
          };
  
      // Send the fetch request
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_ENDPOINT}user/text_generation?session_id=${encodeURIComponent(
          session
        )}&user_info=${encodeURIComponent(fingerprint)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal,
        }
      );
  
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to send message");
      }
  
      // Handle comparison responses
      if (isComparison) {
        setIsEvaluationActive(true);
        let evaluationBuffer = "";
        const wsUrl = constructCompTextGenWebSocketUrl();
        wsRef.current = new WebSocket(wsUrl, "graphql-ws");
  
        const evaluationPromise = new Promise((resolve) => {
          wsRef.current.onopen = () => {
            wsRef.current.send(JSON.stringify({ type: "connection_init" }));
            wsRef.current.send(
              JSON.stringify({
                id: session,
                type: "start",
                payload: {
                  data: JSON.stringify({
                    query: `subscription OnNotify($sessionId: String!) {
                      onNotify(sessionId: $sessionId) {
                        message
                        sessionId
                      }
                    }`,
                    variables: { sessionId: session },
                  }),
                  extensions: {
                    authorization: {
                      Authorization: "API_KEY=",
                      host: new URL(process.env.NEXT_PUBLIC_APPSYNC_API_URL)
                        .hostname,
                    },
                  },
                },
              })
            );
          };
  
          // Handle incoming messages
          // Inside your sendMessage function (comparison branch)
          wsRef.current.onmessage = (event) => {
  
  let messageData;
  try {
    messageData = JSON.parse(event.data);
  } catch (err) {
    console.error("Failed to parse event data:", err);
    return;
  }
  

  if (messageData.type === "data" && messageData.payload?.data?.onNotify) {
    const receivedMessage = messageData.payload.data.onNotify.message;
    
    
    // Check if the message indicates evaluation complete
    if (receivedMessage.includes("EVALUATION_COMPLETE")) {
      
      setIsEvaluationActive(false);
      setEvaluationComplete(true);
      setIsLoading(false);
      wsRef.current.close();
      resolve(true);
      return;
    }
    
    
    // Update evaluationBuffer and messages
    evaluationBuffer += evaluationBuffer ? `\n\n${receivedMessage}` : receivedMessage;
    
    
    setMessages((prev) => {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage?.Type === "ai" && lastMessage?.isCombined) {
        const updatedMessages = [
          ...prev.slice(0, -1),
          { ...lastMessage, Content: evaluationBuffer },
        ];
        
        return updatedMessages;
      } else {
        const updatedMessages = [
          ...prev,
          { Type: "ai", Content: evaluationBuffer, isCombined: true },
        ];
        
        return updatedMessages;
              }
            });
          }
        };


          // Handle WebSocket errors
          wsRef.current.onerror = (error) => {
            console.error("WebSocket error:", error);
            wsRef.current.close();
            setIsLoading(false);
            resolve(false); // Resolve without rejecting on error
          };
        });
  
        // Timeout after 3 minutes if evaluation does not complete
        await Promise.race([
          evaluationPromise,
          new Promise((resolve) => setTimeout(() => resolve(false), 180000)),
        ]);
  
        setIsEvaluationActive(false);
      } else {
        // Handle non-comparison responses
        const data = await response.json();
        setMessages((prev) => [
          ...prev,
          {
            Type: "ai",
            Content: data.content,
            Options: data.options || [],
            user_role: data.user_role,
          },
        ]);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        // It's an intentional abort (session reset). Do NOT toast or log an error.
        
        return;
      }
      console.error("Error sending message:", error);
      setMessages((prev) => [
        ...prev,
        {
          Type: "ai",
          Content: `Error: ${error.message}`,
          isError: true,
        },
      ]);
      toast.error(error.message);
    } finally {
      
      setIsLoading(false);
    }
  };
  
  

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && !isCreatingSession && messageInput.trim()) {
        sendMessage(messageInput);
      }
    }
  };

  const createNewSession = async (currentFingerprint) => {
    if (!currentFingerprint) return;
    setIsCreatingSession(true);
    try {
      const response = await fetch(
        `${
          process.env.NEXT_PUBLIC_API_ENDPOINT
        }user/create_session?user_info=${encodeURIComponent(
          currentFingerprint
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const sessionDataJson = await response.json();
      const sessionData = sessionDataJson[0].session_id;
      setSession(sessionData);
      sessionStorage.setItem("chatSession", JSON.stringify(sessionData));

      const textGenResponse = await fetch(
        `${
          process.env.NEXT_PUBLIC_API_ENDPOINT
        }user/text_generation?session_id=${encodeURIComponent(
          sessionData
        )}&user_info=${encodeURIComponent(fingerprint)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      
      if (!textGenResponse.ok) {
        throw new Error(`HTTP error! status: ${textGenResponse.status}`);
      }
    } catch (error) {
      console.error("Error creating session:", error);
    } finally {
      setIsCreatingSession(false);
    }
  };

  const fetchMessages = async (sessionId) => {
    if (!sessionId) return;

    try {
      const response = await fetch(
        `${
          process.env.NEXT_PUBLIC_API_ENDPOINT
        }user/get_messages?session_id=${encodeURIComponent(sessionId)}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        setMessages([INITIAL_MESSAGE]);
        return;
      }

      const data = await response.json();
      let messagesList = data.messages || [];

      const hasInitialMessage =
        messagesList.length > 0 &&
        messagesList[0].Type === "ai" &&
        messagesList[0].Content.includes("Please select the best role below");

      if (!hasInitialMessage) {
        messagesList = [INITIAL_MESSAGE, ...messagesList];
      }

      setMessages(messagesList);
    } catch (error) {
      console.error("Error fetching messages:", error);
      setMessages([INITIAL_MESSAGE]);
    }
  };

  useEffect(() => {
    getFingerprint()
      .then((result) => {
        setFingerprint(result);
      })
      .catch((error) => {
        console.error("Error getting fingerprint:", error);
      });
      const existingSession = sessionStorage.getItem("chatSession");
      if (existingSession) {
        const parsedSession = JSON.parse(existingSession);
        setSession(parsedSession);
        fetchMessages(parsedSession);
      }
  }, []);

  useEffect(() => {
    if (!fingerprint || session) return;
    createNewSession(fingerprint);
  }, [fingerprint, session]);

  useEffect(() => {
    if (session) {
      fetchMessages(session);
    }
  }, [session]);

  useEffect(() => {
    // Create a function that will run when the page is refreshing
    const handlePageRefresh = (e) => {
      // Clear the session
      sessionStorage.removeItem("chatSession");
      
      // Optionally cancel the refresh and redirect to home manually
      // for more control over the process
      e.preventDefault();
      e.returnValue = '';
      
      // Navigate to home page instead
      setPage("home");
      return '';
    };
  
    // Add beforeunload event listener which catches browser refreshes
    window.addEventListener('beforeunload', handlePageRefresh);
    
    // Clean up the event listener on component unmount
    return () => {
      window.removeEventListener('beforeunload', handlePageRefresh);
    };
  }, [setPage]);
  
  const handleSessionReset = async () => {
    // 1. Clear local feedback state, etc.
    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setShowFeedback(false);
  
    // 2. Remove old session from localStorage
    sessionStorage.removeItem("chatSession");
    
     // Reset evaluationComplete so "My task is done" won't appear right away
    setEvaluationComplete(false);
    setIsLoading(false);
    setDocumentProcessing(false);
    setIsEvaluationActive(false);
    // 3. Clear out old messages, leaving only the initial prompt
    setMessages([INITIAL_MESSAGE]);
  
    // 4. Actually create a brand new session on the backend
    const newSessionId = await createNewSession(fingerprint);
  
    // 5. Save that new ID in state, but do *not* fetchMessages
    setSession(newSessionId);
  };

  const renderMessage = (message, index) => {
    if (message.Type === "human") {
      return <UserMessage key={index} text={message.Content} />;
    } else if (message.Type === "ai") {
      const userRole = getUserRole(messages);
  
      const isEduOrAdminRole =
        userRole.toLowerCase().includes("educator") ||
        userRole.toLowerCase().includes("admin");
  
      return (
        <React.Fragment key={index}>
          <MainMessage text={message.Content} />  {/* Ensure this handles markdown */}
  
          {/* Render existing options */}
          {message.Options &&
            message.Options.map((option, optIndex) => (
              <OptionMessage
                key={`${index}-${optIndex}`}
                text={option}
                onClick={() =>
                  !isLoading && !isCreatingSession && sendMessage(option, true)
                }
              />
            ))}

  
            {
              // Don’t show “My task is done” if we’re already at the final Thank You
              !message.Content.includes("Thank you! Your feedback will help improve") &&
              
              // CASE A: user has done enough messages (index >= 4) AND not in the middle of evaluation
              // OR
              // CASE B: the evaluation is fully done
              ((index >= 4 && !isEvaluationActive) || evaluationComplete) && (
                <OptionMessage
                  key="done"
                  text="My task is done"
                  onClick={() => setShowFeedback(true)}
                />
              )
            }

            {isEduOrAdminRole && !isEvaluationActive && index > 0 && (
              <OptionMessage
                key="syllabus"
                text="I want to compare my course materials with the Digital Learning Strategy areas of discovery"
                icon={TbLayersDifference}
                onClick={() => setShowSyllabusModal(true)}
              />
            )}

        </React.Fragment>
      );
    }
    return null;
  };
  

  
  const constructWebSocketUrl = () => {
    const tempUrl = process.env.NEXT_PUBLIC_GRAPHQL_WS_URL;
    const apiUrl = tempUrl.replace("https://", "wss://");
    const urlObj = new URL(apiUrl);
    const tmpObj = new URL(tempUrl);
    const modifiedHost = urlObj.hostname.replace(
      "appsync-api",
      "appsync-realtime-api"
    );

    urlObj.hostname = modifiedHost;
    const host = tmpObj.hostname;
    // Get credentials from Cognito Identity Pool
    let credentials = null;
    try {
      // Get credentials from an async function but handle it synchronously
      // since constructWebSocketUrl isn't async
      getWebSocketCredentials().then(creds => {
        credentials = creds;
      }).catch(error => {
        console.error('Error getting WebSocket credentials:', error);
      });
    } catch (error) {
      console.error('Error in credentials retrieval:', error);
    }
    // Only use credentials without fallback to static key
    const header = {
      host: host,
      Authorization: credentials ? `Bearer ${credentials.sessionToken}` : "",
    };

    const encodedHeader = btoa(JSON.stringify(header));
    const payload = "e30=";

    return `${urlObj.toString()}?header=${encodedHeader}&payload=${payload}`;
  };

  const handleSyllabusSubmit = async () => {
    
  
    try {
      // First set loading state to disable message input
      setIsLoading(true);
      setDocumentProcessing(true);
      setEvaluationComplete(false);
      // Add user message immediately
      setMessages((prev) => [
        ...prev,
        {
          Type: "human",
          Content: "I've uploaded course files for comparison",
        },
      ]);
  
      
      // Process and upload files (including text if available)
      await processAndUploadFiles(syllabusFiles, textSyllabus, session);

      const wsUrl = constructWebSocketUrl();
      wsRef.current = new WebSocket(wsUrl, "graphql-ws");

      // Rest of websocket code remains the same
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 180000);
        wsRef.current.onopen = () => {
          

          const initMessage = { type: "connection_init" };
          
          wsRef.current.send(JSON.stringify(initMessage));

          const subscriptionMessage = {
            id: session,
            type: "start",
            payload: {
              data: `{"query":"subscription OnNotify($sessionId: String!) { onNotify(sessionId: $sessionId) { message sessionId } }","variables":{"sessionId":"${session}"}}`,
              extensions: {
                authorization: {
                  Authorization: "API_KEY=",
                  host: new URL(process.env.NEXT_PUBLIC_GRAPHQL_WS_URL)
                    .hostname,
                },
              },
            },
          };
          
          wsRef.current.send(JSON.stringify(subscriptionMessage));
        };

        wsRef.current.onmessage = (event) => {
          const message = JSON.parse(event.data);
          

          if (message.type === "data" && message.payload?.data?.onNotify) {
            const receivedMessage = message.payload.data.onNotify.message;
            
            if (receivedMessage === "Embeddings created successfully") {
              clearTimeout(timeoutId);
              wsRef.current.close();
              resolve(message);
            } else {
              // Add non-embedding messages as AI responses
              setMessages((prev) => [
                ...prev,
                { Type: "ai", Content: receivedMessage }
              ]);
              setDocumentProcessing(false);
              setIsEvaluationActive(false);
              setEvaluationComplete(true);
              setIsLoading(false);
              setTextSyllabus("");
              setSyllabusFiles([]);
              wsRef.current.close();
              clearTimeout(timeoutId);
              
            }
          }
        };
        wsRef.current.onerror = (error) => {
          clearTimeout(timeoutId);
          console.error("WebSocket error:", error);
          reject(error);
        };

      });

      // Only remove user message if embeddings were successfully created
      setMessages((prev) => {
        const index = [...prev]
          .reverse()
          .findIndex(
            (message) =>
              message.Content === "I've uploaded course files for comparison"
          );
        if (index !== -1) {
          const reversedMessages = [...prev];
          reversedMessages.splice(prev.length - 1 - index, 1);
          return reversedMessages;
        }
        return prev;
      });

      // Send message for comparison after WebSocket connection
      setDocumentProcessing(false);
      await sendMessage(
        "I've uploaded course files for comparison",
        true,
        true
      );
      
      
      // Reset state
      setTextSyllabus("");
      setSyllabusFiles([]);
    } catch (error) {
      console.error("Syllabus upload error:", error);
      toast.error("Failed to upload syllabus: " + error.message);
    } finally {
      if (wsRef.current) {
        wsRef.current.close();
      }
      setIsLoading(false);
      setDocumentProcessing(false);
    }
  };

  return (
    <div className="w-full h-screen flex flex-col">
      <Header setPage={setPage} onReset={handleSessionReset} />

      {/* 3. Attach ref & onScroll to the main scrollable div */}
      <div
        className="flex-grow overflow-y-auto pt-8 flex flex-col"
        ref={chatContainerRef}
        onScroll={handleScroll}
      >
        <div className="flex-grow px-8 flex flex-col">
          {messages.map((message, index) => renderMessage(message, index))}
          
          {/* Your loading spinner logic */}
          {(isLoading || isCreatingSession) && (
            documentProcessing ? (
              <TypingIndicatorProcessing />
            ) : (
              <TypingIndicator />
            )
          )}

          {/* Your feedback modal */}
          {showFeedback && (
            <FeedbackComponent
              feedback={feedback}
              setFeedback={setFeedback}
              onSubmit={handleFeedbackSubmit}
              isSubmitting={isSendingFeedback}
              onClose={() => setShowFeedback(false)}
            />
          )}

          {/* 4. The “anchor” for auto-scroll. We only scroll here if autoScroll===true */}
          <div ref={messagesEndRef} className="mb-8" />
        </div>
      </div>

      {/* Your footer / input area */}
      <div className="flex flex-col">
        <div className="border-t border-b border-black w-full flex items-center justify-between px-8">
          <div className="flex-grow mx-4 flex items-center">
            <textarea
              ref={textareaRef}
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={handleKeyPress}
              className="px-4 py-2 text-md w-full bg-white text-black resize-none overflow-hidden focus:outline-none flex items-center justify-center"
              placeholder="Type a message..."
              maxLength={2096}
              style={{
                minHeight: "40px",
                height: "auto",
                display: "flex",
                alignItems: "center",
              }}
              rows={1}
              onInput={(e) => {
                e.target.style.height = "auto";
                e.target.style.height = `${Math.max(
                  e.target.scrollHeight,
                  48
                )}px`;
              }}
            />
          </div>
          <button
            onClick={() =>
              !isLoading &&
              !isCreatingSession &&
              messageInput.trim() &&
              sendMessage(messageInput)
            }
            className={`${
              isLoading || isCreatingSession
                ? "opacity-50 cursor-not-allowed"
                : "cursor-pointer"
            }`}
            disabled={isLoading || isCreatingSession}
          >
            <LuSendHorizonal size={20} />
          </button>
        </div>
        <Footer />
      </div>

      <ToastContainer
        position="top-center"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="colored"
      />

      {/* The Syllabus Modal, unchanged */}
      <SyllabusComparisonModal
        isOpen={showSyllabusModal}
        onClose={() => setShowSyllabusModal(false)}
        onSubmit={handleSyllabusSubmit}
        textSyllabus={textSyllabus}
        setTextSyllabus={setTextSyllabus}
        files={syllabusFiles}
        setFiles={setSyllabusFiles}
        selectedCriteria={selectedCriteria}
        setSelectedCriteria={setSelectedCriteria}
      />
    </div>
  );
};

export default Chat;