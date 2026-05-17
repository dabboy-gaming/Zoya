export function processCommand(command: string): {
  action: string;
  url?: string;
  isBrowserAction: boolean;
  shouldCloseSession?: boolean;
} {
  const lowerCmd = command.toLowerCase().trim();

  // 1. YouTube detection
  if (lowerCmd.includes("youtube") && (lowerCmd.includes("play") || lowerCmd.includes("search") || lowerCmd.includes("open"))) {
    let query = lowerCmd.replace(/.*(?:play|search|open)\s+(.+?)(?:\s+on\s+youtube)?$/i, "$1").trim();
    if (query === "youtube") query = ""; // user just said "open youtube"
    return {
      action: query ? `Searching YouTube for ${query}.` : "Opening YouTube for you.",
      url: query ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` : "https://www.youtube.com",
      isBrowserAction: true,
    };
  }

  // 2. Spotify detection
  if (lowerCmd.includes("spotify") && (lowerCmd.includes("play") || lowerCmd.includes("search") || lowerCmd.includes("open"))) {
    let query = lowerCmd.replace(/.*(?:play|search|open)\s+(.+?)(?:\s+on\s+spotify)?$/i, "$1").trim();
    if (query === "spotify") query = ""; 
    return {
      action: query ? `Searching Spotify for ${query}.` : "Opening Spotify.",
      url: query ? `https://open.spotify.com/search/${encodeURIComponent(query)}` : "https://open.spotify.com",
      isBrowserAction: true,
    };
  }

  // 3. WhatsApp detection
  if (lowerCmd.includes("whatsapp")) {
    const waMatch = lowerCmd.match(/(?:send|whatsapp)\s+(?:message\s+to\s+)?([\d\+\s]+)(?:\s+saying\s+)?(.+)?/);
    if (waMatch) {
      const number = waMatch[1].replace(/\s+/g, "");
      const message = waMatch[2] ? encodeURIComponent(waMatch[2].trim()) : "";
      return {
        action: `Opening WhatsApp for you.`,
        url: `https://web.whatsapp.com/send?phone=${number}${message ? `&text=${message}` : ""}`,
        isBrowserAction: true,
      };
    }
  }

  // 4. General Browsing: "Open [website name]"
  const openMatch = lowerCmd.match(/open\s+(.+)$/);
  if (openMatch) {
    let website = openMatch[1].trim().replace(/\s+/g, "");
    
    if (website.match(/^(https?:\/\/)/)) {
        return {
          action: `Opening ${openMatch[1]}.`,
          url: website,
          isBrowserAction: true,
        };
    }

    if (website === "about:blank") {
        return {
          action: `Opening a blank page.`,
          url: "about:blank",
          isBrowserAction: true,
        };
    }

    if (!website.includes(".")) {
      website += ".com";
    }

    const finalUrl = website.startsWith("www.") ? `https://${website}` : `https://www.${website}`;

    return {
      action: `Opening ${openMatch[1]}.`,
      url: finalUrl,
      isBrowserAction: true,
    };
  }

  // 5. Sleep/Close Session detection
  if (lowerCmd.includes("sleep") || lowerCmd.includes("close session") || lowerCmd.includes("bye bye") || lowerCmd.includes("see you later") || lowerCmd.includes("so jao") || lowerCmd.includes("sone ja rahi") || lowerCmd.includes("sone ja raha")) {
    return {
      action: "Closing the session. Goodnight!",
      isBrowserAction: false,
      shouldCloseSession: true
    };
  }

  return { action: "", isBrowserAction: false };
}
