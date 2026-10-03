import React, { useMemo } from "react";
import parse, { attributesToProps, domToReact } from "html-react-parser";
import type { DOMNode, HTMLReactParserOptions } from "html-react-parser";
import { sanitizeReportHtml, sourceUrl, type PublishedReport, type ReportItem } from "../util/reports";
import "./Article.css";
import ItemList, { type ContentsItem } from "./ItemList";

const SourceAttribution = ({ item }: { item: ReportItem }) => (
  <div className="source-attribution">
    <a href={sourceUrl(item.url)} target="_blank" rel="noopener noreferrer">
      <div className="source-info">
        <span className="source-title">{item.title}</span>
      </div>
    </a>
  </div>
);

export default function Article({ report }: { report: PublishedReport }) {
  const parsed = useMemo(() => {
    try {
      const itemsById = new Map(report.items.map(item => [item.id, item]));
      const cleanHtml = sanitizeReportHtml(report.narrative_html);
      if (!cleanHtml.trim()) throw new Error("Report has no readable content.");
      const document = new DOMParser().parseFromString(cleanHtml, "text/html");
      const contents: ContentsItem[] = [];
      for (const section of Array.from(document.querySelectorAll("section[data-source-id]"))) {
        const source = itemsById.get(section.getAttribute("data-source-id")!);
        const title = section.querySelector(":scope > h2")?.textContent?.trim();
        if (!source || !title) continue;
        const anchor = `article-section-${contents.length + 1}`;
        section.id = anchor;
        contents.push({ title, anchor, source });
      }
      const hasIntro = !!document.querySelector("p.intro");
      let contentsInserted = false;
      const options: HTMLReactParserOptions = {
        replace: domNode => {
          if (!("attribs" in domNode)) return;

          const isIntro = domNode.name === "p" && domNode.attribs.class?.split(/\s+/).includes("intro");
          if (!contentsInserted && (hasIntro ? isIntro : domNode.name === "h1")) {
            contentsInserted = true;
            return (
              <>
                {React.createElement(domNode.name, attributesToProps(domNode.attribs),
                  domToReact(domNode.children as DOMNode[], options))}
                <ItemList items={contents} />
              </>
            );
          }

          if (domNode.name === "section" && domNode.attribs["data-source-id"]) {
            const sourceItem = itemsById.get(domNode.attribs["data-source-id"]);
            let headingProcessed = false;
            const children: React.ReactNode[] = [];
            domNode.children.forEach((child, index) => {
              children.push(
                <React.Fragment key={index}>
                  {domToReact([child] as DOMNode[], options)}
                </React.Fragment>,
              );
              if (!headingProcessed && "name" in child && child.name === "h2") {
                headingProcessed = true;
                if (sourceItem) {
                  children.push(<SourceAttribution key="source" item={sourceItem} />);
                }
              }
            });
            return <section {...attributesToProps(domNode.attribs)} tabIndex={-1}>{children}</section>;
          }
        },
      };

      const content = parse(document.body.innerHTML, options);
      return { content, contents, contentsInserted };
    } catch {
      return { error: "This report could not be displayed. Please try another time." };
    }
  }, [report]);

  if ("error" in parsed) return <div className="error-message" role="alert">{parsed.error}</div>;

  return (
    <div className="report-container">
      {!parsed.contentsInserted && <ItemList items={parsed.contents} />}
      {parsed.content}
    </div>
  );
}
