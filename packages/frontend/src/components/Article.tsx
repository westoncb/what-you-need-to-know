import React, { useMemo } from "react";
import parse, { attributesToProps, domToReact } from "html-react-parser";
import type { DOMNode, HTMLReactParserOptions } from "html-react-parser";
import { sanitizeReportHtml, sourceUrl, type PublishedReport, type ReportItem } from "../util/reports";
import "./Article.css";
import ItemList from "./ItemList";

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
      const options: HTMLReactParserOptions = {
        replace: domNode => {
          if (!("attribs" in domNode)) return;

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
            return <section {...attributesToProps(domNode.attribs)}>{children}</section>;
          }
        },
      };

      const cleanHtml = sanitizeReportHtml(report.narrative_html);
      if (!cleanHtml.trim()) throw new Error("Report has no readable content.");
      const content = parse(cleanHtml, options);
      return { content };
    } catch {
      return { error: "This report could not be displayed. Please try another time." };
    }
  }, [report]);

  if ("error" in parsed) return <div className="error-message" role="alert">{parsed.error}</div>;

  return (
    <div className="report-container">
      {parsed.content}
      <ItemList items={report.items} />
    </div>
  );
}
