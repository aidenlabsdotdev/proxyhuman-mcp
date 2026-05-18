export interface ConnectOptions {
  /** ProxyHuman API key */
  apiKey: string;
  /** Chrome DevTools Protocol HTTP endpoint, e.g. http://localhost:9222 */
  cdpTarget: string;
  /** API base URL, defaults to https://api.proxyhuman.ai */
  apiUrl?: string;
  /** Path to ffmpeg binary, defaults to ../bin/ffmpeg or $FFMPEG_PATH */
  ffmpegPath?: string;
}

export interface BrowserSession {
  sessionId: string;
  viewerUrl: string;
  close(): Promise<void>;
  onDisconnect(handler: () => void): void;
  onComplete(handler: () => void): void;
}

export type RelayMessage = {
  type: string;
  [key: string]: unknown;
};
