import React, { useState } from "react";
import LightweightModal from "./LightWeightModal";
import "./ItemList.css";
import { sourceUrl as safeSourceUrl } from "../util/reports";

const ItemList = ({ items = [] }) => {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <div className="item-list-container">
      <h3 className="item-list-heading">Source Materials</h3>
      <div className="item-list">
        {items.map((item, index) => (
          <Item key={index} item={item} />
        ))}
      </div>
    </div>
  );
};

// Source website URLs
const sourceUrls = {
  hn: "https://news.ycombinator.com",
  arxiv: "https://arxiv.org",
  // Add more sources as needed
};

// Tooltip descriptions
const sourceDescriptions = {
  hn: "Hacker News - Technology news and discussions",
  arxiv: "arXiv - Open access archive for scholarly articles"
};

// Inline Item component
const Item = ({ item }) => {
  const [activeTooltip, setActiveTooltip] = useState(null);
  const [modalContent, setModalContent] = useState(null);

  // Extract source type (e.g., "hn" from "hn_43912164")
  const sourceType = item?.src || (item?.id ? item.id.split('_')[0] : 'unknown');
  const sourceUrl = sourceUrls[sourceType] || "#";
  const sourceDescription = sourceDescriptions[sourceType] || `Source: ${sourceType}`;

  // Handle modal open/close
  const openModal = (type) => {
    if (type === 'context') {
      setModalContent({
        title: 'Context',
        content: item.context,
        type: 'context'
      });
    } else if (type === 'why') {
      setModalContent({
        title: 'Why This Matters',
        content: item.why,
        type: 'why'
      });
    }
  };

  const closeModal = () => {
    setModalContent(null);
  };

  // Handle null or undefined
  if (!item) return null;

  return (
    <>
      <div className="item-row">
        <div
          className="item-source"
          onMouseEnter={() => setActiveTooltip('source')}
          onMouseLeave={() => setActiveTooltip(null)}
        >
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            <span className="source-indicator">{sourceType}</span>
          </a>
          {activeTooltip === 'source' && (
            <div className="item-tooltip source-tooltip">
              <div className="tooltip-content">
                {sourceDescription}
              </div>
            </div>
          )}
        </div>

        <div className="item-title" title={item.title}>
          <a href={safeSourceUrl(item.url)} target="_blank" rel="noopener noreferrer">
            {item.title}
          </a>
        </div>

        <div className="item-actions">
          {item.context && (
            <button
              type="button"
              aria-label={`Read context for ${item.title}`}
              className="item-action-button ctx-button"
              onClick={() => openModal('context')}
            >
              <span className="action-label">ctx</span>
            </button>
          )}

          {item.why && (
            <button
              type="button"
              aria-label={`Read why ${item.title} matters`}
              className="item-action-button why-button"
              onClick={() => openModal('why')}
            >
              <span className="action-label">why</span>
            </button>
          )}
        </div>
      </div>

      {/* Modal for Context or Why content */}
      {modalContent && (
        <LightweightModal
          isOpen={true}
          onClose={closeModal}
          title={modalContent.title}
          content={modalContent.content}
          className={`${modalContent.type}-modal`}
        />
      )}
    </>
  );
};

export default ItemList;
