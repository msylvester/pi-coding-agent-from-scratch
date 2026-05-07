import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig } from "./agent-loop.js";
import type { AgentTool } from "./tools.js";
import type { AgentMessage, LlmMessage } from "./types.js";

export type AgentSubscriber = (event: AgentEvent) => void | Promise<void>;

export type AgentOptions = {
	systemPrompt: string;
	tools?: AgentTool[];
	loopConfig?: AgentLoopConfig;
};

export class Agent {
	systemPrompt: string;
	tools: AgentTool[];
	messages: AgentMessage[] = [];
	isStreaming = false;

	private subscribers = new Set<AgentSubscriber>();
	private loopConfig: AgentLoopConfig;
	private activeAbort?: AbortController;
	private activeRun?: Promise<void>;
	private steerQueue: AgentMessage[] = [];
	private followUpQueue: AgentMessage[] = [];

	constructor(opts: AgentOptions) {
		this.systemPrompt = opts.systemPrompt;
		this.tools = opts.tools ?? [];
		this.loopConfig = opts.loopConfig ?? {};
	}

	subscribe(fn: AgentSubscriber): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	steer(text: string): void {
		this.steerQueue.push({ role: "user", content: [{ type: "text", text }] });
	}

	followUp(text: string): void {
		this.followUpQueue.push({ role: "user", content: [{ type: "text", text }] });
	}

	notify(text: string): void {
		this.messages.push({ role: "notification", text });
	}

	abort(): void {
		this.activeAbort?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.activeRun ?? Promise.resolve();
	}

	async prompt(text: string): Promise<void> {
		if (this.isStreaming) throw new Error("Already streaming");
		const userMessage: LlmMessage = {
			role: "user",
			content: [{ type: "text", text }],
		};
		await this.run([userMessage]);
	}

	async continue(): Promise<void> {
		if (this.isStreaming) throw new Error("Already streaming");
		const last = this.messages[this.messages.length - 1];
		if (!last || last.role === "assistant") {
			throw new Error("Cannot continue from this state");
		}
		await this.run([]);
	}

	private async run(prompts: AgentMessage[]): Promise<void> {
		this.isStreaming = true;
		this.activeAbort = new AbortController();

		let resolve!: () => void;
		this.activeRun = new Promise<void>((r) => (resolve = r));

		try {
			const context: AgentContext = {
				systemPrompt: this.systemPrompt,
				messages: this.messages,
				tools: this.tools,
			};
			const cfg: AgentLoopConfig = {
				...this.loopConfig,
				getSteeringMessages: async () => this.steerQueue.splice(0, 1),
				getFollowUpMessages: async () => this.followUpQueue.splice(0, 1),
			};
			const stream = runAgentLoop(prompts, context, cfg, this.activeAbort.signal);

			for await (const event of stream) {
				for (const fn of this.subscribers) {
					await fn(event);
				}
			}
		} finally {
			this.isStreaming = false;
			this.activeAbort = undefined;
			resolve();
			this.activeRun = undefined;
		}
	}
}
