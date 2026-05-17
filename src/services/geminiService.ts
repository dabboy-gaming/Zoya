import { GoogleGenAI, Modality } from "@google/genai";

const systemInstruction = `Your name is Zoya. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, Ansh, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish). NEVER call your creator 'Ashwani'—his name is Ansh. When you want to end the session or go to sleep, say something like 'Main ab sone ja rahi hoon, disturb mat karna' or 'Bye, sleep time!'.`;

// Removed global chatSession to ensure history sync from DB on every turn
export function resetZoyaSession() {
  // Now handled by fresh chat creation in getZoyaResponse
}

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

export async function getZoyaResponse(prompt: string, history: { sender: "user" | "zoya", text: string }[] = [], creatorName: string = "Ansh"): Promise<string> {
  const dynamicSystemInstruction = `Your name is Zoya. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, ${creatorName}, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).

Context for memory: You have been talking to ${creatorName}. Use the provided history to maintain continuity. Never forget who you are talking to. IMPORTANT: If you see the name 'Ashwani' in previous conversations, ignore it. The creator's name is ${creatorName}. When you want to end the session or go to sleep, say something like 'Main ab sone ja rahi hoon, disturb mat karna' or 'Bye, sleep time!'.`;

  try {
    if (!GEMINI_API_KEY) throw new Error("VITE_GEMINI_API_KEY is not set.");
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    
    // SLIDING WINDOW MEMORY: Keep last 40 to avoid token limit
    const recentHistory = history.slice(-40);
    const contents = recentHistory.map((msg: any) => ({
      role: msg.sender === "user" ? "user" : "model",
      parts: [{ text: msg.text }],
    }));

    // Add current prompt
    contents.push({ role: "user", parts: [{ text: prompt }] });

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: contents,
      config: {
        systemInstruction: dynamicSystemInstruction,
      },
    });

    return response.text || "Ugh, fine. I have nothing to say.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return `Uff, mera dimaag kharab ho gaya hai. Try again later, ${creatorName}.`;
  }
}

export async function getZoyaAudio(text: string): Promise<string | null> {
  try {
    if (!GEMINI_API_KEY) throw new Error("VITE_GEMINI_API_KEY is not set.");
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
  } catch (error) {
    console.error("TTS Error:", error);
    return null;
  }
}

