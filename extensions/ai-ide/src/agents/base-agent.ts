/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import axios from 'axios';
import * as vscode from 'vscode';

export interface AgentConfig {
	name: string;
	role: string;
	provider: 'openai' | 'ollama' | 'huggingface' | 'anthropic' | 'google' | 'custom';
	model: string;
	settings: {
		apiKey?: string;
		apiUrl?: string;
		temperature?: number;
		maxTokens?: number;
		systemPrompt?: string;
		[key: string]: any;
	};
}

export class BaseAgent {
	private abortController: AbortController | null = null;

	constructor(
		private context: vscode.ExtensionContext,
		public config: AgentConfig,
		private orchestrator: any
	) { }

	async execute(
		task: string,
		context?: any,
		history?: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		this.abortController = new AbortController();

		try {
			// Secret injection before call
			if (!this.config.settings.apiKey && this.context) {
				const storedKey = await this.context.secrets.get(this.config.provider);
				if (storedKey) {
					this.config.settings.apiKey = storedKey;
				}
			}

			progressCallback?.('Analyzing task with context...');

			// Build system prompt
			const systemPrompt = this.config.settings.systemPrompt ||
				`You are ${this.config.name}, a ${this.config.role}. ` +
				`Provide detailed, actionable responses with code examples when appropriate.`;

			// Merge context into prompt more efficiently
			let contextStr = '';
			if (context) {
				if (typeof context === 'string') {
					contextStr = context;
				} else {
					// Extract key parts to avoid massive JSON dumps
					const parts: string[] = [];
					if (context.relevantFiles) {
						parts.push(`Relevant Files: ${Array.isArray(context.relevantFiles) ? context.relevantFiles.join(', ') : context.relevantFiles}`);
					}
					if (context.projectContext) {
						// Project analyzer data - take only necessary bits
						const pc = context.projectContext;
						if (pc.structure) {parts.push(`Project Structure: ${pc.structure}`);}
					}
					if (context.repoMap) {
						parts.push(`Repository Map:\n${context.repoMap}`);
					}
					contextStr = parts.length > 0 ? parts.join('\n') : JSON.stringify(context);
				}
			}

			const fullPrompt = contextStr ?
				`CONTEXT:\n${contextStr}\n\nTASK: ${task}` :
				task;

			// Call LLM based on provider
			const response = await this.callLLM(fullPrompt, systemPrompt, history || [], progressCallback);

			return response;
		} catch (error: any) {
			throw new Error(`Agent ${this.config.name} failed: ${error.message}`);
		}
	}

	private async callLLM(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		switch (this.config.provider) {
			case 'openai':
				return await this.callOpenAI(prompt, systemPrompt, history, progressCallback);
			case 'ollama':
				return await this.callOllama(prompt, systemPrompt, history, progressCallback);
			case 'huggingface':
				return await this.callHuggingFace(prompt, systemPrompt, history, progressCallback);
			case 'anthropic':
				return await this.callAnthropic(prompt, systemPrompt, history, progressCallback);
			case 'google':
				return await this.callGoogle(prompt, systemPrompt, history, progressCallback);
			case 'custom':
				return await this.callCustom(prompt, systemPrompt, history, progressCallback);
			default:
				throw new Error(`Unknown provider: ${this.config.provider}`);
		}
	}

	private async callOpenAI(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		progressCallback?.('Calling OpenAI...');

		const messages = [
			{ role: 'system', content: systemPrompt },
			...history.map(h => ({ role: h.from === 'user' ? 'user' : 'assistant', content: h.content })),
			{ role: 'user', content: prompt }
		];

		const response = await axios.post(
			'https://api.openai.com/v1/chat/completions',
			{
				model: this.config.model,
				messages,
				temperature: this.config.settings.temperature || 0.7,
				max_tokens: this.config.settings.maxTokens || 4000
			},
			{
				headers: {
					'Authorization': `Bearer ${this.config.settings.apiKey}`,
					'Content-Type': 'application/json'
				},
				signal: this.abortController?.signal
			}
		);

		return response.data.choices[0].message.content;
	}

	private async callOllama(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		const url = this.config.settings.apiUrl || 'http://localhost:11434';

		// Check if model exists
		try {
			const tags = await axios.get(`${url}/api/tags`, { signal: this.abortController?.signal });
			const exists = tags.data.models.some((m: any) => m.name === this.config.model || m.name.split(':')[0] === this.config.model);
			if (!exists) {
				const choice = await vscode.window.showWarningMessage(
					`Ollama model "${this.config.model}" is not pulled. Pull it now?`,
					'Pull Model', 'Cancel'
				);
				if (choice === 'Pull Model') {
					await vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: `Pulling ${this.config.model}...`,
						cancellable: false
					}, async (progress: vscode.Progress<{ message?: string }>) => {
						await axios.post(`${url}/api/pull`, { name: this.config.model }, { signal: this.abortController?.signal });
					});
				} else {
					throw new Error(`Model ${this.config.model} not available.`);
				}
			}
		} catch (e: any) {
			if (e.message.includes('not available')) {throw e;}
			console.warn('Unable to check Ollama tags, proceeding anyway...');
		}

		progressCallback?.('Calling Ollama...');
		const historyText = history.map(h => `${h.from}: ${h.content}`).join('\n');
		const fullPrompt = `${systemPrompt}\n\nHistory:\n${historyText}\n\nTask:\n${prompt}`;

		const response = await axios.post(
			`${url}/api/generate`,
			{
				model: this.config.model,
				prompt: fullPrompt,
				stream: false,
				options: {
					temperature: this.config.settings.temperature || 0.7,
					num_gpu: this.config.settings.useGpu ? 99 : 0
				}
			},
			{ signal: this.abortController?.signal }
		);

		return response.data.response;
	}

	private async callHuggingFace(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		progressCallback?.('Calling HuggingFace...');

		const fullPrompt = `${systemPrompt}\n\n${prompt}`;

		const response = await axios.post(
			`https://api-inference.huggingface.co/models/${this.config.model}`,
			{
				inputs: fullPrompt,
				parameters: {
					temperature: this.config.settings.temperature || 0.7,
					max_new_tokens: this.config.settings.maxTokens || 2000
				}
			},
			{
				headers: {
					'Authorization': `Bearer ${this.config.settings.apiKey}`,
					'Content-Type': 'application/json'
				},
				signal: this.abortController?.signal
			}
		);

		return response.data[0].generated_text;
	}

	private async callAnthropic(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		progressCallback?.('Calling Anthropic...');

		const messages = [
			...history.map(h => ({ role: h.from === 'user' ? 'user' : 'assistant', content: h.content })),
			{ role: 'user', content: prompt }
		];

		const response = await axios.post(
			'https://api.anthropic.com/v1/messages',
			{
				model: this.config.model,
				max_tokens: this.config.settings.maxTokens || 4000,
				system: systemPrompt,
				messages
			},
			{
				headers: {
					'x-api-key': this.config.settings.apiKey,
					'anthropic-version': '2023-06-01',
					'Content-Type': 'application/json'
				},
				signal: this.abortController?.signal
			}
		);

		return response.data.content[0].text;
	}

	private async callGoogle(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		progressCallback?.('Calling Google (Gemini)...');

		const response = await axios.post(
			`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.settings.apiKey}`,
			{
				contents: [
					{
						role: 'user',
						parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
					}
				],
				generationConfig: {
					temperature: this.config.settings.temperature || 0.7,
					maxOutputTokens: this.config.settings.maxTokens || 4000
				}
			},
			{
				headers: { 'Content-Type': 'application/json' },
				signal: this.abortController?.signal
			}
		);

		if (response.data.candidates && response.data.candidates[0].content) {
			return response.data.candidates[0].content.parts[0].text;
		}
		throw new Error('Google API returned an empty or malformed response');
	}

	private async callCustom(
		prompt: string,
		systemPrompt: string,
		history: any[],
		progressCallback?: (update: string) => void
	): Promise<string> {
		progressCallback?.('Calling custom endpoint...');

		const url = this.config.settings.apiUrl;
		if (!url) {
			throw new Error('Custom provider requires apiUrl in settings');
		}

		const response = await axios.post(
			url,
			{
				prompt: `${systemPrompt}\n\n${prompt}`,
				model: this.config.model,
				temperature: this.config.settings.temperature || 0.7,
				max_tokens: this.config.settings.maxTokens || 4000
			},
			{
				headers: this.config.settings.apiKey ? {
					'Authorization': `Bearer ${this.config.settings.apiKey}`,
					'Content-Type': 'application/json'
				} : {
					'Content-Type': 'application/json'
				},
				signal: this.abortController?.signal
			}
		);

		// Try to extract response from common formats
		return response.data.response ||
			response.data.content ||
			response.data.text ||
			response.data.choices?.[0]?.message?.content ||
			JSON.stringify(response.data);
	}

	cancel(): void {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	isCancelled(): boolean {
		return this.abortController?.signal.aborted ?? false;
	}
}
