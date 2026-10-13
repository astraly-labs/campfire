import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ContextAssistantSessionId,
  type ContextAssistantStreamEvent,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  CheckCheckIcon,
  GitPullRequestArrowIcon,
  LockKeyholeIcon,
  NetworkIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "~/lib/utils";
import { contextAssistantEnvironment } from "~/state/contextAssistant";
import { useAtomCommand } from "~/state/use-atom-command";

interface BriefingMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
}

interface ThreadBriefingViewProps {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly hidden: boolean;
}

const QUICK_ACTIONS = [
  {
    label: "Summarize this thread",
    description: "Goals, work completed, and current state",
    prompt:
      "Summarize this thread for someone arriving now. Cover the goal, what was done, the current state, and important context.",
    icon: SparklesIcon,
  },
  {
    label: "What remains?",
    description: "Open work, blockers, and next steps",
    prompt:
      "What remains to be done in this thread? Separate confirmed open work, blockers, risks, and the most useful next steps.",
    icon: CheckCheckIcon,
  },
  {
    label: "Key decisions",
    description: "Choices made and why",
    prompt:
      "List the key decisions made in this thread, the reasoning behind them, and any alternatives that were rejected.",
    icon: GitPullRequestArrowIcon,
  },
  {
    label: "Architecture map",
    description: "A visual map of the system discussed",
    prompt:
      "Create a clear architecture map of the system discussed in this thread. Use a Mermaid diagram when it helps, then briefly explain it.",
    icon: NetworkIcon,
  },
] as const;

let nextLocalId = 0;

function localId(prefix: string): string {
  nextLocalId += 1;
  return `${prefix}-${Date.now()}-${nextLocalId}`;
}

function newSessionId(): ContextAssistantSessionId {
  return ContextAssistantSessionId.make(localId("briefing"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ThreadBriefingView({
  environmentId,
  sourceThreadId,
  threadRef,
  cwd,
  hidden,
}: ThreadBriefingViewProps) {
  const ask = useAtomCommand(contextAssistantEnvironment.ask, { reportFailure: false });
  const close = useAtomCommand(contextAssistantEnvironment.close, { reportFailure: false });
  const [sessionId, setSessionId] = useState(newSessionId);
  const sessionIdRef = useRef(sessionId);
  const [messages, setMessages] = useState<ReadonlyArray<BriefingMessage>>([]);
  const [prompt, setPrompt] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(
    () => () => {
      void close({
        environmentId,
        input: { sessionId: sessionIdRef.current },
      });
    },
    [close, environmentId],
  );

  useEffect(() => {
    if (hidden) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [hidden, messages]);

  const updateAssistant = useCallback(
    (assistantMessageId: string, event: ContextAssistantStreamEvent) => {
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== assistantMessageId) return message;
          if (event.type === "assistant.delta") {
            return { ...message, text: message.text + event.delta, streaming: true };
          }
          if (event.type === "assistant.failed") {
            return {
              ...message,
              text: message.text || `I couldn't complete this briefing: ${event.message}`,
              streaming: false,
            };
          }
          return { ...message, streaming: false };
        }),
      );
    },
    [],
  );

  const submitPrompt = useCallback(
    async (rawPrompt: string) => {
      const nextPrompt = rawPrompt.trim();
      if (!nextPrompt || isAnswering) return;

      const userMessage: BriefingMessage = {
        id: localId("briefing-user"),
        role: "user",
        text: nextPrompt,
      };
      const assistantMessageId = localId("briefing-assistant");
      const assistantMessage: BriefingMessage = {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        streaming: true,
      };
      setPrompt("");
      setError(null);
      setIsAnswering(true);
      setMessages((current) => [...current, userMessage, assistantMessage]);

      const result = await ask({
        environmentId,
        input: {
          sessionId,
          sourceThreadId,
          prompt: nextPrompt,
          onEvent: (event) => updateAssistant(assistantMessageId, event),
        },
      });
      if (result._tag === "Failure") {
        const message = errorMessage(squashAtomCommandFailure(result));
        setError(message);
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  text: item.text || `I couldn't complete this briefing: ${message}`,
                  streaming: false,
                }
              : item,
          ),
        );
      }
      setIsAnswering(false);
    },
    [ask, environmentId, isAnswering, sessionId, sourceThreadId, updateAssistant],
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submitPrompt(prompt);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitPrompt(prompt);
  };

  const resetBriefing = async () => {
    if (isAnswering) return;
    const previousSessionId = sessionId;
    const nextSessionId = newSessionId();
    sessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setMessages([]);
    setPrompt("");
    setError(null);
    await close({
      environmentId,
      input: { sessionId: previousSessionId },
    });
  };

  return (
    <section
      aria-label="Private thread briefing"
      className={cn("min-h-0 flex-1 flex-col bg-muted/10", hidden ? "hidden" : "flex")}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-8 sm:px-8 sm:py-12">
            {messages.length === 0 ? (
              <>
                <div className="mb-8">
                  <div className="mb-4 inline-flex size-10 items-center justify-center rounded-xl border border-border bg-background shadow-sm">
                    <LockKeyholeIcon className="size-4.5 text-foreground" />
                  </div>
                  <h1 className="text-balance text-2xl font-semibold tracking-tight">
                    Understand this thread
                  </h1>
                  <p className="mt-2 max-w-xl text-pretty text-sm leading-6 text-muted-foreground">
                    Ask a private assistant about the conversation. Its answers are temporary,
                    visible only to you, and cannot change the project.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      disabled={isAnswering}
                      onClick={() => void submitPrompt(action.prompt)}
                      className="group rounded-xl border border-border bg-background p-4 text-left shadow-xs transition-colors hover:border-foreground/20 hover:bg-muted/30 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <action.icon className="mb-3 size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                      <span className="block text-sm font-medium">{action.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {action.description}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-7">
                <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-4">
                  <div>
                    <h1 className="text-sm font-semibold">Private briefing</h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Temporary · read-only · only visible to you
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isAnswering}
                    onClick={() => void resetBriefing()}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    New briefing
                  </Button>
                </div>
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-6">
                        {message.text}
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="min-h-6 text-sm leading-6">
                      {message.text ? (
                        <ChatMarkdown
                          text={message.text}
                          cwd={cwd}
                          threadRef={threadRef}
                          isStreaming={message.streaming ?? false}
                          className="max-w-none"
                        />
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <SparklesIcon className="size-3.5 animate-pulse" />
                          Reading the conversation…
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border/70 bg-background/95 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 backdrop-blur sm:px-8">
          <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl">
            {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
            <div className="relative">
              <Textarea
                value={prompt}
                size="sm"
                rows={2}
                disabled={isAnswering}
                aria-label="Ask about this thread"
                placeholder="Ask about this thread…"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handleKeyDown}
                className="pr-12"
              />
              <Button
                type="submit"
                size="icon-sm"
                disabled={!prompt.trim() || isAnswering}
                aria-label="Send briefing question"
                className="absolute bottom-2 right-2"
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
            <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <LockKeyholeIcon className="size-3" />
              This briefing is not added to the conversation.
            </p>
          </form>
        </div>
      </div>
    </section>
  );
}
