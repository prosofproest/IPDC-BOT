import { createLogger } from '../utils/logger.js';

const log = createLogger('ai');

/**
 * Gemini primary, Groq immediate failover. Short timeout; no waiting on long retries.
 * Prompts are never logged (they may reference member activity); only provider status is.
 */
export class AiService {
  constructor(cfg, health) { this.cfg = cfg; this.health = health; this.fetch = globalThis.fetch; }

  async _post(url, init) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try { const res = await this.fetch(url, { ...init, signal: ctl.signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); }
    finally { clearTimeout(t); }
  }

  async gemini(prompt, system) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.geminiModel}:generateContent`;
    const j = await this._post(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.geminiKey },
      body: JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 400 } }) });
    return j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  }

  async groq(prompt, system) {
    const j = await this._post('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.groqKey}` },
      body: JSON.stringify({ model: this.cfg.groqModel, temperature: 0.3, max_tokens: 400, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }) });
    return j?.choices?.[0]?.message?.content || '';
  }

  /** Returns { text, provider } or { text: null, provider: null } when both fail. */
  async generate(prompt, { system } = {}) {
    const usable = (t) => typeof t === 'string' && t.trim().length >= 10;
    try {
      const t = await this.gemini(prompt, system);
      if (usable(t)) { this.health?.record('ai:gemini', true); return { text: t.trim(), provider: 'gemini' }; }
      throw new Error('unusable output');
    } catch (e) {
      this.health?.record('ai:gemini', false, e.name === 'AbortError' ? 'timeout' : e.message);
      log.warn(`Gemini failed (${e.name === 'AbortError' ? 'timeout' : e.message}); failing over to Groq`);
    }
    try {
      const t = await this.groq(prompt, system);
      if (usable(t)) { this.health?.record('ai:groq', true); return { text: t.trim(), provider: 'groq' }; }
      throw new Error('unusable output');
    } catch (e) {
      this.health?.record('ai:groq', false, e.name === 'AbortError' ? 'timeout' : e.message);
      log.warn(`Groq failed (${e.name === 'AbortError' ? 'timeout' : e.message})`);
      return { text: null, provider: null };
    }
  }

  /** Neutral activity summary from aggregate counts and commit subjects only (no member identities). */
  async summarizeActivity({ repo, days, commits, prs, subjects }) {
    const system = 'You write brief, neutral engineering activity summaries for a student project team. Do not rank, score or judge individuals. Two or three plain sentences. No emojis.';
    const prompt = `Repository ${repo}, last ${days} day(s): ${commits} commits, ${prs} pull requests.\nCommit subjects:\n${subjects.slice(0, 40).map((s) => `- ${s}`).join('\n')}\nSummarize the themes of the work.`;
    return this.generate(prompt, { system });
  }
}
