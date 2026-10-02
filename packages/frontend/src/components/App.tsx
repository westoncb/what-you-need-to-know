import React, { useState, useEffect } from "react";
import Article from "./Article";
import { loadLatestReport, type PublishedReport } from "../util/reports";
import "./App.css";

const AI_MODELS = [
  {
    id: "claude-3-7",
    name: "Claude Sonnet 3.7",
    image: `${import.meta.env.BASE_URL}images/claude-3-7.png`,
    banner: `${import.meta.env.BASE_URL}images/claude-banner.jpg` // Path to the banner you generated
  },
  {
    id: "gpt-4-5",
    name: "GPT-4.5",
    image: `${import.meta.env.BASE_URL}images/gpt-4-5.png`,
    banner: `${import.meta.env.BASE_URL}images/gpt-banner.jpg` // You'll need to generate this
  },
  {
    id: "gemini-flash",
    name: "Gemini Flash 2.5",
    image: `${import.meta.env.BASE_URL}images/gemini-flash.png`,
    banner: `${import.meta.env.BASE_URL}images/gemini-banner.jpg` // You'll need to generate this
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState(AI_MODELS[0].id);
  const [report, setReport] = useState<PublishedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReport(null);

    loadLatestReport(import.meta.env.BASE_URL, controller.signal)
      .then(report => {
        if (!controller.signal.aborted) setReport(report);
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : "Could not load the latest report.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="app-container">
      <div className="app-content">
        <div className="title-bar">
          <div className="title-bar-content">
            <div className="app-title">ai-hourly-news</div>
          </div>
        </div>

        <div className="tabs-container">
          <div className="tabs">
            {AI_MODELS.map((model) => (
              <button
                key={model.id}
                className={`tab ${activeTab === model.id ? 'active' : ''}`}
                onClick={() => setActiveTab(model.id)}
              >
                {/* <img
                  src={model.image}
                  alt={model.name}
                  className="tab-image"
                /> */}
                <span className="tab-name">{model.name}</span>
              </button>
            ))}
          </div>

          {report && (
            <div className="report-metadata">
              <span>{report.generated_at
                ? `Generated ${new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium", timeZone: "America/Phoenix",
                  }).format(new Date(report.generated_at))}`
                : `Report for ${report.day}`}</span>
              <span>{report.model}</span>
            </div>
          )}

          <div className="tab-content">
            {loading ? (
              <div className="loading-container" role="status">
                <div className="loading-spinner"></div>
                <p>Loading reports...</p>
              </div>
            ) : error ? (
              <div className="error-message" role="alert">
                <h3>Error loading reports</h3>
                <p>{error}</p>
                <button className="retry-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
              </div>
            ) : !report ? (
              <div className="loading-container" role="status">
                <h3>No reports yet</h3>
                <p>Check back after the first report is published.</p>
              </div>
            ) : (
              <div className="article-frame">
                <Article report={report} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
