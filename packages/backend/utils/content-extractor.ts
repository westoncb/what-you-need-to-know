import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import fetch from 'node-fetch';
import striptags from 'striptags';

/**
 * Represents the result of content extraction
 */
export interface ExtractedContent {
  /** The main textual content */
  text: string;
  /** Title of the page if available */
  title?: string;
  /** Brief text excerpt or description */
  excerpt?: string;
  /** URL of the document */
  url: string;
  /** Extraction method that succeeded */
  method: string;
  /** When the content was extracted */
  timestamp: Date;
}

/**
 * Configuration options for the content extractor
 */
export interface ExtractorOptions {
  /** Maximum length of extracted content */
  maxContentLength?: number;
  /** Timeout for fetching URLs in milliseconds */
  fetchTimeoutMs?: number;
  /** User agent to use for requests */
  userAgent?: string;
  /** Enable fallback extraction methods */
  enableFallbacks?: boolean;
}

/**
 * Default options for the extractor
 */
const DEFAULT_OPTIONS: ExtractorOptions = {
  maxContentLength: 5000,
  fetchTimeoutMs: 10000,
  userAgent: 'Mozilla/5.0 (compatible; NewsBot/1.0)',
  enableFallbacks: true,
};

/**
 * ContentExtractor - Utility class for extracting readable content from web pages
 */
export class ContentExtractor {
  private options: ExtractorOptions;

  /**
   * Creates a new ContentExtractor
   * @param options Configuration options
   */
  constructor(options: ExtractorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Extract content from a URL
   * @param url The URL to extract content from
   * @returns Extracted content or null if extraction failed
   */
  async extract(url: string): Promise<ExtractedContent | null> {
    if (!this.isValidUrl(url)) {
      return null;
    }

    try {
      const html = await this.fetchHtml(url);

      // First try Readability (primary method)
      const readabilityResult = await this.extractWithReadability(html, url);
      if (readabilityResult) {
        return {
          ...readabilityResult,
          url,
          method: 'readability',
          timestamp: new Date(),
        };
      }

      // If Readability fails and fallbacks are enabled, try simple extraction
      if (this.options.enableFallbacks) {
        const fallbackResult = this.extractWithFallback(html);
        if (fallbackResult) {
          return {
            ...fallbackResult,
            url,
            method: 'fallback',
            timestamp: new Date(),
          };
        }
      }

      return null;
    } catch (error) {
      console.error(`Error extracting content from ${url}: ${error.message}`);
      return null;
    }
  }

  /**
   * Validate that a URL is properly formed and supported
   */
  private isValidUrl(url: string): boolean {
    // Skip non-HTTP URLs
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return false;
    }

    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Fetch HTML content from a URL
   */
  private async fetchHtml(url: string): Promise<string> {
    try {
      // Handle redirects and set a more realistic timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.fetchTimeoutMs);

      const response = await fetch(url, {
        timeout: this.options.fetchTimeoutMs,
        headers: {
          'User-Agent': this.options.userAgent || DEFAULT_OPTIONS.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'follow',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Handle non-success responses
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      // Be more lenient with content type checking
      // Some sites don't set proper content types or have MIME type issues
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/pdf') ||
          contentType.includes('image/') ||
          contentType.includes('audio/') ||
          contentType.includes('video/')) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }

      // Get the HTML content
      const html = await response.text();

      // Simple check if the content looks like HTML (has tags)
      if (!html.includes('<')) {
        throw new Error('Response does not appear to be HTML');
      }

      return html;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Fetch timeout after ${this.options.fetchTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract content using Mozilla's Readability library
   */
  private async extractWithReadability(html: string, url: string): Promise<Partial<ExtractedContent> | null> {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        return null;
      }

      // Trim and clean the content
      const text = this.cleanText(article.textContent);

      if (text.length < 50) {
        // If extracted text is too short, probably not useful content
        return null;
      }

      return {
        text: text.slice(0, this.options.maxContentLength),
        title: article.title,
        excerpt: article.excerpt,
      };
    } catch (error) {
      console.warn(`Readability extraction failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fallback extraction method using simple HTML stripping
   */
  private extractWithFallback(html: string): Partial<ExtractedContent> | null {
    try {
      // Extract title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : undefined;

      // Basic content extraction using striptags
      let text = striptags(html);
      text = this.cleanText(text);

      if (text.length < 50) {
        return null;
      }

      return {
        text: text.slice(0, this.options.maxContentLength),
        title,
      };
    } catch (error) {
      console.warn(`Fallback extraction failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Clean extracted text
   */
  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .replace(/\n+/g, '\n') // Normalize newlines
      .trim();
  }
}
