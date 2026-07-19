import { Container, Markdown } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme } from "../theme/theme";

/**
 * Native OMP transcript block for the assistant text owned by one E4 turn.
 *
 * The block deliberately contains only one Markdown child. Streaming updates
 * mutate that child in place, so a delta never creates another assistant row.
 */
export class BreadboardAssistantText extends Container {
	readonly #markdown: Markdown;
	#text: string;
	#finalized = false;

	constructor(text = "") {
		super();
		this.#text = text;
		this.#markdown = new Markdown(text, 1, 0, getMarkdownTheme());
		this.#markdown.transientRenderCache = true;
		this.addChild(this.#markdown);
	}

	get text(): string {
		return this.#text;
	}

	get markdown(): Markdown {
		return this.#markdown;
	}

	get finalized(): boolean {
		return this.#finalized;
	}

	setText(text: string, finalized = this.#finalized): void {
		this.#text = text;
		this.#finalized = finalized;
		this.#markdown.setText(text);
		this.#markdown.transientRenderCache = !finalized;
		this.invalidate();
	}

	append(text: string): void {
		if (this.#finalized) return;
		this.setText(this.#text + text);
	}

	finalize(text = this.#text): void {
		this.setText(text, true);
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
}
