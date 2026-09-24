declare module "word-extractor" {
  export interface ExtractedWordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getTextboxes(options?: {
      includeBody?: boolean;
      includeHeadersAndFooters?: boolean;
    }): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<ExtractedWordDocument>;
  }
}
