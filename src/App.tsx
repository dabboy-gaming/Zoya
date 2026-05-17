import React, { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, Loader2, Volume2, VolumeX, Keyboard, Send, Trash2, LogIn, LogOut } from "lucide-react";
import { getZoyaResponse, getZoyaAudio, resetZoyaSession } from "./services/geminiService";
import { processCommand } from "./services/commandService";
import { LiveSessionManager } from "./services/liveService";
import Visualizer from "./components/Visualizer";
import PermissionModal from "./components/PermissionModal";
import { playPCM } from "./utils/audioUtils";
import { motion, AnimatePresence } from "motion/react";
import { auth, signInWithGoogle } from "./lib/firebase";
import { onAuthStateChanged, User, signOut } from "firebase/auth";
import { saveUserPreferences, getUserData, saveMessage, subscribeToMessages, deleteChatHistory } from "./lib/firestore";

type AppState = "idle" | "listening" | "processing" | "speaking";

interface ChatMessage {
  id: string;
  sender: "user" | "zoya";
  text: string;
  timestamp?: any;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [appState, setAppState] = useState<AppState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  const [isMuted, setIsMuted] = useState(false);
  const [creatorName, setCreatorName] = useState("Ansh");
  const [pendingAction, setPendingAction] = useState<{ url: string, label: string } | null>(null);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const liveSessionRef = useRef<LiveSessionManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wakeWordRecognitionRef = useRef<any>(null);

  // Wake Word Detection
  useEffect(() => {
    if (!user || isSessionActive || appState !== "idle") {
      if (wakeWordRecognitionRef.current) {
        wakeWordRecognitionRef.current.stop();
        wakeWordRecognitionRef.current = null;
      }
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-IN"; // Good for Hinglish

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0])
        .map((result: any) => result.transcript)
        .join("")
        .toLowerCase();

      if (transcript.includes("wakeup zoya") || transcript.includes("wake up zoya") || transcript.includes("utho zoya")) {
        console.log("Wake word detected!");
        toggleListening();
      }
    };

    recognition.onerror = (event: any) => {
      console.warn("Wake word recognition error:", event.error);
      if (event.error === "not-allowed") {
        // Permissions not granted yet, don't retry automatically
      } else {
        // Retry logic for other errors
        setTimeout(() => {
          if (!isSessionActive && !wakeWordRecognitionRef.current) {
             try { recognition.start(); } catch(e) {}
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      // Small delay before restarting if still idle and not active
      if (!isSessionActive && appState === "idle") {
        setTimeout(() => {
          try { recognition.start(); } catch(e) {}
        }, 300);
      }
    };

    try {
      recognition.start();
      wakeWordRecognitionRef.current = recognition;
    } catch (e) {
      console.error("Failed to start wake word recognition", e);
    }

    return () => {
      if (wakeWordRecognitionRef.current) {
        wakeWordRecognitionRef.current.stop();
        wakeWordRecognitionRef.current = null;
      }
    };
  }, [user, isSessionActive, appState]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsLoadingAuth(false);
      
      if (currentUser) {
        // Load preferences
        const userData = await getUserData(currentUser.uid);
        if (userData?.preferences) {
          setIsMuted(!!userData.preferences.isMuted);
          if (userData.preferences.creatorName) {
            // Force migration if they were still called Ashwani
            if (userData.preferences.creatorName.toLowerCase() === "ashwani") {
              setCreatorName("Ansh");
              saveUserPreferences(currentUser.uid, { creatorName: "Ansh" });
            } else {
              setCreatorName(userData.preferences.creatorName);
            }
          } else {
            // Default to Ansh if no name set
            setCreatorName("Ansh");
            saveUserPreferences(currentUser.uid, { creatorName: "Ansh" });
          }
        } else {
          // Default to Ansh for new users
          setCreatorName("Ansh");
          saveUserPreferences(currentUser.uid, { creatorName: "Ansh" });
        }
      } else {
        setMessages([]);
        setIsMuted(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Messages Subscription
  useEffect(() => {
    if (user) {
      const unsubscribe = subscribeToMessages(user.uid, (newMessages) => {
        setMessages(newMessages);
        messagesRef.current = newMessages;
      });
      return () => unsubscribe();
    }
  }, [user]);

  // Sync Mute Preference
  const toggleMute = useCallback(() => {
    const newMute = !isMuted;
    setIsMuted(newMute);
    if (user) {
      saveUserPreferences(user.uid, { isMuted: newMute });
    }
  }, [isMuted, user]);

  useEffect(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.isMuted = isMuted;
    }
  }, [isMuted]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, appState]);

  const handleTextCommand = useCallback(async (finalTranscript: string) => {
    if (!finalTranscript.trim() || !user) {
      setAppState("idle");
      return;
    }

    // Save user message
    const userMsg = { sender: "user" as const, text: finalTranscript };
    await saveMessage(user.uid, userMsg);
    
    // If live session is active, send text through it
    if (isSessionActive && liveSessionRef.current) {
      liveSessionRef.current.sendText(finalTranscript);
      return;
    }

    setAppState("processing");

    // 1. Check for browser commands
    const commandResult = processCommand(finalTranscript);

    if (commandResult.shouldCloseSession) {
       setAppState("processing");
       const response = "Theek hai, main sone ja rahi hoon. Goodnight!";
       await saveMessage(user.uid, { sender: "zoya", text: response });
       
       if (!isMuted) {
         setAppState("speaking");
         const audio = await getZoyaAudio(response);
         if (audio) await playPCM(audio);
       }
       
       setAppState("idle");
       if (isSessionActive) {
         toggleListening();
       }
       return;
    }

    // Detect creator name change BEFORE calling Gemini
    let activeCreatorName = creatorName;
    const nameMatch = finalTranscript.toLowerCase().match(/my self ([\w\s]+) and i am your creator/i) 
                || finalTranscript.toLowerCase().match(/my name is ([\w\s]+)/i);
    
    if (nameMatch && nameMatch[1]) {
      const newName = nameMatch[1].trim();
      activeCreatorName = newName;
      setCreatorName(newName);
      if (user) {
        saveUserPreferences(user.uid, { creatorName: newName });
      }
    }

    let responseText = "";

    if (commandResult.isBrowserAction && commandResult.url) {
      responseText = commandResult.action;
      
      // Attempt auto-open, but also show button as fallback
      setPendingAction({ url: commandResult.url, label: commandResult.action });
      
      await saveMessage(user.uid, { sender: "zoya", text: responseText });
      
      if (!isMuted) {
        setAppState("speaking");
        const audioBase64 = await getZoyaAudio(responseText);
        if (audioBase64) {
          await playPCM(audioBase64);
        }
      }

      setAppState("idle");

      setTimeout(() => {
        if (commandResult.url && commandResult.url !== "https://www.") {
          try {
            window.open(commandResult.url, "_blank");
          } catch (e) {
            console.error("Auto-open blocked, relying on manual button", e);
          }
        }
      }, 1500);
    } else {
      // 2. General Chit-Chat via Gemini
      // Include current user message in context explicitly
      const contextHistory = [...messagesRef.current, userMsg];
      responseText = await getZoyaResponse(finalTranscript, contextHistory, activeCreatorName);
      await saveMessage(user.uid, { sender: "zoya", text: responseText });
      
      if (!isMuted) {
        setAppState("speaking");
        const audioBase64 = await getZoyaAudio(responseText);
        if (audioBase64) {
          await playPCM(audioBase64);
        }
      }
      setAppState("idle");
    }
  }, [isMuted, isSessionActive, user]);

  useEffect(() => {
    return () => {
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
      }
    };
  }, []);

  const toggleListening = async () => {
    if (!user) return;

    if (isSessionActive) {
      setIsSessionActive(false);
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
        liveSessionRef.current = null;
      }
      setAppState("idle");
      resetZoyaSession();
    } else {
      try {
        setIsSessionActive(true);
        resetZoyaSession();
        
        const session = new LiveSessionManager();
        session.isMuted = isMuted;
        liveSessionRef.current = session;
        
        session.onStateChange = (state) => {
          setAppState(state);
          if (state === "idle") {
            setIsSessionActive(false);
            liveSessionRef.current = null;
            // Only alert if it was active and suddenly went idle (indicates close)
          }
        };
        
        session.onMessage = (sender, text) => {
          if (user) {
            saveMessage(user.uid, { sender, text });
            
            // Auto-close session if Zoya says she's going to sleep
            if (sender === "zoya") {
              const cmd = processCommand(text);
              if (cmd.shouldCloseSession) {
                setTimeout(() => {
                  if (liveSessionRef.current) {
                    toggleListening();
                  }
                }, 2000); // Give a moment for the speech to finish or be seen
              }
            }
          }
        };
        
        session.onCommand = (url) => {
          setPendingAction({ url, label: "Open Link" });
          setTimeout(() => {
            window.open(url, "_blank");
          }, 1000);
        };

        await session.start(messagesRef.current, creatorName);
      } catch (e) {
        console.error("Failed to start session", e);
        setShowPermissionModal(true);
        setIsSessionActive(false);
        setAppState("idle");
      }
    }
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    
    handleTextCommand(textInput);
    setTextInput("");
    setShowTextInput(false);
  };

  const handleLogin = async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      console.error("Login failed", e);
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="h-screen w-screen bg-[#050505] flex items-center justify-center">
        <Loader2 className="animate-spin text-violet-500" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-screen bg-[#050505] text-white flex flex-col items-center justify-center gap-8 relative overflow-hidden">
        <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-violet-900/20 blur-[120px] rounded-full" />
          <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-pink-900/20 blur-[120px] rounded-full" />
        </div>
        
        <div className="z-10 flex flex-col items-center gap-4 text-center px-6">
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-20 h-20 rounded-full bg-gradient-to-tr from-violet-500 to-pink-500 flex items-center justify-center font-bold text-3xl shadow-[0_0_50px_rgba(139,92,246,0.3)] mb-4"
          >
            Z
          </motion.div>
          <h1 className="text-4xl md:text-5xl font-serif font-bold tracking-tight">Zoya</h1>
          <p className="text-white/60 max-w-md text-lg italic">
            "I'm sassy, I'm smart, and I remember everything. But only if you log in, {creatorName}."
          </p>
          <button
            onClick={handleLogin}
            className="mt-6 flex items-center gap-3 px-8 py-4 bg-white text-black rounded-full font-bold hover:bg-white/90 transition-all hover:scale-105 active:scale-95 shadow-xl"
          >
            <LogIn size={20} />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-screen bg-[#050505] text-white flex flex-col items-center justify-between font-sans relative overflow-hidden m-0 p-0">
      {showPermissionModal && (
        <PermissionModal 
          onClose={() => setShowPermissionModal(false)} 
        />
      )}

      {/* Action Overlay */}
      <AnimatePresence>
        {pendingAction && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] bg-black/90 backdrop-blur-2xl border border-white/20 p-8 rounded-3xl shadow-[0_0_80px_rgba(139,92,246,0.3)] flex flex-col items-center gap-6 text-center max-w-sm w-[90%] pointer-events-auto"
          >
            <div className="w-16 h-16 rounded-full bg-violet-500/20 flex items-center justify-center text-violet-400">
              <Send size={32} />
            </div>
            <div>
              <h3 className="text-xl font-bold mb-2">Browser Action Required</h3>
              <p className="text-white/60 text-sm italic">"{pendingAction.label}"</p>
              <p className="text-white/40 text-[10px] mt-2 uppercase tracking-tighter">Browsers block auto-tabs, please click below</p>
            </div>
            <div className="flex gap-3 w-full">
               <button
                onClick={() => setPendingAction(null)}
                className="flex-1 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors text-sm font-medium"
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  window.open(pendingAction.url, "_blank");
                  setPendingAction(null);
                }}
                className="flex-[2] px-4 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 transition-colors text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-violet-900/40"
              >
                Open It!
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cinematic Background Gradients */}
      <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-violet-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-pink-900/20 blur-[120px] rounded-full" />
      </div>

      {/* Header */}
      <header className="absolute top-0 left-0 w-full flex justify-between items-center z-20 shrink-0 px-6 py-4 md:px-12 md:py-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-violet-500 to-pink-500 flex items-center justify-center font-bold text-sm">
            Z
          </div>
          <h1 className="text-xl font-serif font-medium tracking-wide opacity-90">Zoya</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => signOut(auth)}
            className="p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10"
            title="Sign Out"
          >
            <LogOut size={18} className="opacity-70" />
          </button>
          <button
            onClick={toggleMute}
            className="p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? (
              <VolumeX size={18} className="opacity-70" />
            ) : (
              <Volume2 size={18} className="opacity-70" />
            )}
          </button>
        </div>
      </header>

      {/* Main Content - Visualizer & Chat */}
      <main className="absolute inset-0 flex flex-row items-center justify-between w-full h-full z-10 overflow-hidden pt-20 pb-24 px-4 md:px-12 pointer-events-none">
        
        {/* Left Column: Zoya Status */}
        <div className="flex w-[30%] lg:w-[25%] h-full flex-col justify-center gap-4 z-10">
          <div className="h-6">
            <AnimatePresence>
              {appState === "processing" && (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="flex items-center gap-2 text-cyan-300/80 text-sm md:text-base italic font-serif"
                >
                  <Loader2 size={16} className="animate-spin" />
                  Replying...
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Center Visualizer (Fixed Full Screen Background) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <Visualizer 
            state={appState} 
            isWakeWordListening={!isSessionActive && appState === "idle" && !!user} 
          />
        </div>

        {/* Right Column: User Status */}
        <div className="flex w-[30%] lg:w-[25%] h-full flex-col justify-center gap-4 z-10">
          <div className="h-6 flex justify-end">
            <AnimatePresence>
              {appState === "listening" && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="flex items-center gap-2 text-violet-300/80 text-sm md:text-base italic"
                >
                  <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
                  Listening...
                </motion.div>
              )}
              {appState === "idle" && !isSessionActive && user && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 text-white/20 text-[10px] md:text-xs tracking-[0.2em] font-bold uppercase transition-all"
                >
                  <div className="w-1 h-1 rounded-full bg-white/20" />
                  Watching...
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

      </main>

      {/* Chat History Overlay (Mobile & Desktop) */}
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-black/40 backdrop-blur-xl border-l border-white/10 z-30 transition-transform duration-500 translate-x-full lg:translate-x-0 lg:static lg:bg-transparent lg:backdrop-blur-none lg:border-none lg:flex lg:flex-col pointer-events-auto">
        <div className="p-6 overflow-y-auto scrollbar-hide h-full flex flex-col gap-4">
          <div className="flex items-center justify-between pointer-events-auto">
            <h2 className="text-sm font-bold uppercase tracking-widest text-white/40">Conversation</h2>
            {!showClearConfirm ? (
              <button 
                onClick={() => setShowClearConfirm(true)}
                className="text-xs text-red-400/50 hover:text-red-400 font-medium transition-colors"
              >
                Clear
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setShowClearConfirm(false)}
                  className="text-[10px] text-white/40 hover:text-white uppercase font-bold tracking-wider"
                >
                  Cancel
                </button>
                <button 
                  onClick={async () => {
                    if (user) {
                      await deleteChatHistory(user.uid);
                      resetZoyaSession();
                      setShowClearConfirm(false);
                    }
                  }}
                  className="text-[10px] text-red-500 hover:text-red-400 uppercase font-bold tracking-wider"
                >
                  Confirm Clear?
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-4 pb-20">
            {messages.map((msg, i) => (
              <motion.div
                key={msg.id || i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                  msg.sender === "user" 
                    ? "bg-violet-500/20 text-violet-100 self-end rounded-tr-none border border-violet-500/20" 
                    : "bg-white/5 text-white/90 self-start rounded-tl-none border border-white/10"
                }`}
              >
                <div className="text-[10px] uppercase opacity-50 mb-1 font-bold tracking-tight">
                  {msg.sender === "user" ? user.displayName?.split(' ')[0] || "Me" : "Zoya"}
                </div>
                {msg.text}
              </motion.div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* Controls */}
      <footer className="absolute bottom-0 left-0 w-full flex flex-col items-center justify-center pb-6 md:pb-8 z-40 shrink-0 gap-4">
        <AnimatePresence>
          {showTextInput && (
            <motion.form 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onSubmit={handleTextSubmit}
              className="w-full max-w-md flex items-center gap-2 bg-white/5 border border-white/10 rounded-full p-1 pl-4 backdrop-blur-md shadow-2xl mx-4"
            >
              <input 
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Type a message to Zoya..."
                className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-white/30 text-sm"
                autoFocus
              />
              <button 
                type="submit"
                disabled={!textInput.trim()}
                className="p-2 rounded-full bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:hover:bg-violet-500 transition-colors"
              >
                <Send size={16} />
              </button>
            </motion.form>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4">
          <button
            onClick={toggleListening}
            className={`
              group relative flex items-center gap-3 px-8 py-4 rounded-full font-medium tracking-wide transition-all duration-300 shadow-2xl
              ${
                isSessionActive
                  ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                  : "bg-white/10 text-white border border-white/20 hover:bg-white/20 hover:scale-105"
              }
            `}
          >
            {isSessionActive ? (
              <>
                <MicOff size={20} />
                <span>End Session</span>
              </>
            ) : (
              <>
                <Mic size={20} className="group-hover:animate-bounce" />
                <span>Start Session</span>
              </>
            )}
          </button>
          
          {!isSessionActive && (
            <button
              onClick={() => setShowTextInput(!showTextInput)}
              className="p-4 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors shadow-2xl"
              title="Type instead"
            >
              <Keyboard size={20} className="opacity-70" />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
