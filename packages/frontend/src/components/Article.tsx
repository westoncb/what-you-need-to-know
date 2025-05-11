import React, { useState, useEffect } from "react";
import parse, { domToReact } from "html-react-parser";
import "./Article.css";
import ItemList from './ItemList';

// Placeholder for the source attribution component
const SourceAttribution = ({ item }) => {
  const [showContext, setShowContext] = useState(false);
  return (
    <div className="source-attribution">
      <a href={item?.url || "#"} target="_blank" rel="noopener noreferrer">
        <div className="source-info">
          <span className="source-title">{item?.title || "Unknown Source"}</span>
        </div>
      </a>
    </div>
  );
};

const Article = ({ report }) => {
  const [parsedContent, setParsedContent] = useState(null);

  useEffect(() => {
    if (report && report.narrative_html) {
      try {
        console.log("Report items:", report.items);

        // Create a map of items by ID for easy lookup
        const itemsById = {};
        if (report.items) {
          report.items.forEach(item => {
            itemsById[item.id] = item
          });

          console.log("test:", itemsById)
        }

        let ledeFound = false;

        // Parse the HTML content
        const options = {
          replace: (domNode) => {
            if (!domNode.attribs) return undefined;

            if (
              !ledeFound &&
              domNode.type === 'tag' &&
              domNode.name === 'p' &&
              domNode.attribs.class === 'lede'
            ) {
              ledeFound = true; // Mark that we found the lede
              return (
                <>
                  <p className="lede">{domToReact(domNode.children, options)}</p>
                  <ItemList items={report.items} />
                </>
              );
            }

            // Handle sections with source IDs
            if (
              domNode.type === 'tag' &&
              domNode.name === 'section' &&
              domNode.attribs['data-source-id']
            ) {
              const sourceId = domNode.attribs['data-source-id'];
              const sourceItem = itemsById[sourceId];

              // Find the title node to attach the source attribution after it
              const children = [];
              let titleProcessed = false;

              for (let i = 0; i < domNode.children.length; i++) {
                const child = domNode.children[i];
                children.push(domToReact([child], options));

                // After the section title, add the source attribution
                if (
                  !titleProcessed &&
                  child.type === 'tag' &&
                  child.name === 'h2' &&
                  child.attribs &&
                  child.attribs.class === 'section-title'
                ) {
                  titleProcessed = true;
                  if (sourceItem) {
                    children.push(<SourceAttribution key={`source-${sourceId}`} item={sourceItem} />);
                  }
                }
              }

              return <section {...domNode.attribs}>{children}</section>;
            }

            return undefined;
          }
        };

        const content = parse(report.narrative_html, options);
        setParsedContent(content);
      } catch (error) {
        console.error("Error parsing HTML:", error);
        setParsedContent(<div className="error">Error parsing report content</div>);
      }
    }
  }, [report]);

  if (!report) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Preparing today's curated report...</p>
      </div>
    );
  }

  if (parsedContent) {
    return <div className="report-container">{parsedContent}</div>;
  }

  return <div>No report content available.</div>;
};

export default Article;
