import React, { useEffect, useState } from 'react';

interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

// Storage keys
const STORAGE_URL_KEY = 'fiddy.agent.url';
const STORAGE_KEY_KEY = 'fiddy.agent.key';

const AgentPage: React.FC = () => {
  // State management
  const [connectionState, setConnectionState] = useState<
    'NOT_HATCHED' | 'PAIRING' | 'CONNECTED'
  >('NOT_HATCHED');
  const [agentUrl, setAgentUrl] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [schedulerInput, setSchedulerInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load persisted credentials on mount
  useEffect(() => {
    const storedUrl = localStorage.getItem(STORAGE_URL_KEY);
    const storedKey = localStorage.getItem(STORAGE_KEY_KEY);

    if (storedUrl && storedKey) {
      setAgentUrl(storedUrl);
      setAgentKey(storedKey);
      setConnectionState('CONNECTED');
    }
  }, []);

  const handleHatch = () => {
    window.open('https://fiddy.fun/start', '_blank', 'noopener');
  };

  const handlePair = () => {
    setConnectionState('PAIRING');
    setError(null);
  };

  const validateUrl = (url: string): boolean => {
    const regex = /^https:\/\/[a-z0-9-]+\.agent37\.app$/;
    return regex.test(url);
  };

  const handleConnect = () => {
    if (!validateUrl(agentUrl)) {
      setError('Invalid instance URL. Must match ^https://[a-z0-9-]+.agent37.app$');
      return;
    }
    if (!agentKey.trim()) {
      setError('Agent key is required');
      return;
    }

    localStorage.setItem(STORAGE_URL_KEY, agentUrl);
    localStorage.setItem(STORAGE_KEY_KEY, agentKey);
    setConnectionState('CONNECTED');
    setError(null);
  };

  const handleDisconnect = () => {
    localStorage.removeItem(STORAGE_URL_KEY);
    localStorage.removeItem(STORAGE_KEY_KEY);
    setAgentUrl('');
    setAgentKey('');
    setMessages([]);
    setConnectionState('NOT_HATCHED');
    setError(null);
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || !agentUrl || !agentKey) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${agentUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent37-Key': agentKey,
        },
        body: JSON.stringify({ input: text }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = await response.json();
      const agentContent =
        payload.output_text || JSON.stringify(payload, null, 2);

      const agentMessage: ChatMessage = {
        role: 'agent',
        content: agentContent,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, agentMessage]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);

      const errorMsg: ChatMessage = {
        role: 'agent',
        content: `Error: ${errorMessage}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleSchedulerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (schedulerInput.trim()) {
      sendMessage(`Please schedule this recurring task: ${schedulerInput}`);
      setSchedulerInput('');
    }
  };

  // NOT HATCHED STATE
  if (connectionState === 'NOT_HATCHED') {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h1 className="mb-4 text-3xl font-bold text-white">
            Your 24/7 AI Agent
          </h1>
          <p className="mb-6 text-lg text-gray-400">
            A personal Hermes agent that works around the clock. Schedule tasks
            like «check my mentions every morning» or «draft my weekly recap».
          </p>

          <div className="mb-8 rounded-lg border border-[#24292e] bg-[#161715] p-4 text-left">
            <h3 className="mb-3 font-semibold text-[#d4ff3f]">
              Available Channels
            </h3>
            <ul className="space-y-1 text-sm text-gray-300">
              <li>• Farcaster – owner approval for each action</li>
              <li>• iMessage – owner approval for each action</li>
              <li>• Discord – owner approval for each action</li>
              <li>• Telegram – owner approval for each action</li>
              <li>• WhatsApp – owner approval for each action</li>
              <li>• Email – owner approval for each action</li>
            </ul>
          </div>

          <button
            onClick={handleHatch}
            className="solid-glass-pane inline-block rounded-lg bg-[#d4ff3f] px-6 py-3 text-sm font-semibold text-[#1a1c10] transition-opacity hover:opacity-90"
          >
            Hatch your Fiddy →
          </button>

          <div className="mt-6">
            <button
              onClick={handlePair}
              className="text-sm text-gray-500 underline hover:text-gray-400"
            >
              Already have an agent? Pair it
            </button>
          </div>
        </div>
      </div>
    );
  }

  // PAIRING STATE
  if (connectionState === 'PAIRING') {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="w-full max-w-md">
          <h1 className="mb-6 text-2xl font-bold text-white">Pair Your Agent</h1>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm text-gray-400">
                Instance URL
              </label>
              <input
                type="text"
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                placeholder="https://your-agent.agent37.app"
                className="w-full rounded-lg border border-[#24292e] bg-[#0c0c0c] px-4 py-2 text-white placeholder-gray-600 focus:border-[#d4ff3f] focus:outline-none"
              />
              <p className="mt-1 text-xs text-gray-500">
                Must match https://[name].agent37.app
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm text-gray-400">
                Agent Key
              </label>
              <input
                type="password"
                value={agentKey}
                onChange={(e) => setAgentKey(e.target.value)}
                placeholder="Enter your agent key"
                className="w-full rounded-lg border border-[#24292e] bg-[#0c0c0c] px-4 py-2 text-white placeholder-gray-600 focus:border-[#d4ff3f] focus:outline-none"
              />
              <p className="mt-1 text-xs text-gray-500">
                This key stays in this browser only
              </p>
            </div>

            {error && (
              <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setConnectionState('NOT_HATCHED')}
                className="flex-1 rounded-lg border border-[#24292e] py-2 text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
              >
                Back
              </button>
              <button
                onClick={handleConnect}
                className="flex-1 rounded-lg bg-[#d4ff3f] px-4 py-2 font-semibold text-[#1a1c10] transition-opacity hover:opacity-90"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // CONNECTED STATE
  return (
    <div className="flex h-full flex-col p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Fiddy Agent</h1>
        <button
          onClick={handleDisconnect}
          className="rounded-lg border border-red-800 px-3 py-1 text-sm text-red-400 transition-colors hover:bg-red-900/20"
        >
          Disconnect
        </button>
      </div>

      {/* Error Display */}
      {error && connectionState === 'CONNECTED' && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-red-800 bg-red-900/20 p-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            onClick={() => setConnectionState('PAIRING')}
            className="text-sm text-[#d4ff3f] underline hover:text-[#ccff5c]"
          >
            Re-pair
          </button>
        </div>
      )}

      {/* Chat Panel */}
      <div className="solid-glass-pane mb-4 flex flex-1 flex-col overflow-hidden rounded-lg">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-gray-500">
              <p>Send a message to start chatting with your agent</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      msg.role === 'user'
                        ? 'bg-[#d4ff3f] text-[#1a1c10]'
                        : 'border border-[#24292e] bg-[#0c0c0c] text-gray-200'
                    }`}
                  >
                    <pre className="whitespace-pre-wrap font-sans text-sm">
                      {msg.content}
                    </pre>
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="border border-[#24292e] bg-[#0c0c0c] p-3 text-gray-400">
                    <span className="animate-pulse">Thinking...</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className="flex border-t border-[#24292e] p-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message your agent..."
            disabled={isLoading}
            className="flex-1 rounded-lg border border-[#24292e] bg-[#0c0c0c] px-4 py-2 text-white placeholder-gray-600 focus:border-[#d4ff3f] focus:outline-none"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="ml-2 rounded-lg bg-[#d4ff3f] px-4 py-2 font-semibold text-[#1a1c10] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>

      {/* Scheduler Helper */}
      <div className="rounded-lg border border-[#24292e] bg-[#161715] p-4">
        <h3 className="mb-2 text-sm font-semibold text-[#d4ff3f]">
          Schedule a Task
        </h3>
        <form onSubmit={handleSchedulerSubmit} className="flex gap-2">
          <input
            type="text"
            value={schedulerInput}
            onChange={(e) => setSchedulerInput(e.target.value)}
            placeholder="e.g., Check my mentions every morning at 9am"
            className="flex-1 rounded-lg border border-[#24292e] bg-[#0c0c0c] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-[#d4ff3f] focus:outline-none"
          />
          <button
            type="submit"
            disabled={!schedulerInput.trim()}
            className="rounded-lg border border-[#d4ff3f] px-3 py-2 text-sm font-medium text-[#d4ff3f] transition-opacity hover:bg-[#d4ff3f]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Schedule
          </button>
        </form>
      </div>
    </div>
  );
};

export { AgentPage };