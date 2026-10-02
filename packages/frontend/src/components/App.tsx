import React, { useState, useEffect } from "react";
import { modelConfig, type ReportIndexEntry, type WriterConfig } from "@wyntn/common/src/models";
import Article from "./Article";
import { loadReportIndex, loadWriterReport, type PublishedReport } from "../util/reports";
import "./App.css";

function WriterReport({ day, writer }: { day: ReportIndexEntry; writer: WriterConfig }) {
  const [report, setReport] = useState<PublishedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReport(null);
    loadWriterReport(import.meta.env.BASE_URL, day, writer, controller.signal)
      .then(report => { if (!controller.signal.aborted) setReport(report); })
      .catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load this report.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [day, writer, attempt]);

  if (loading) return <div className="loading-container" role="status"><p>Loading {writer.name}’s report...</p></div>;
  if (error) return (
    <div className="error-message" role="alert">
      <h3>Error loading report</h3><p>{error}</p>
      <button className="retry-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
    </div>
  );
  if (!report) return (
    <div className="loading-container" role="status">
      <h3>Report unavailable</h3>
      <p>No report from {writer.name} is available for {day.day}.</p>
    </div>
  );
  return (
    <>
      <div className="report-metadata">
        <span>{report.generated_at
          ? `Generated ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Phoenix" }).format(new Date(report.generated_at))}`
          : `Report for ${report.day}`}</span>
        <span>{report.model}</span>
      </div>
      <div className="tab-content"><div className="article-frame"><Article report={report} /></div></div>
    </>
  );
}

export default function App() {
  const [activeWriterId, setActiveWriterId] = useState(modelConfig.writers[0].id);
  const [index, setIndex] = useState<ReportIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const writer = modelConfig.writers.find(writer => writer.id === activeWriterId) ?? modelConfig.writers[0];

  useEffect(() => {
    const controller = new AbortController();
    setIndex(null);
    setError(null);
    loadReportIndex(import.meta.env.BASE_URL, controller.signal)
      .then(index => { if (!controller.signal.aborted) setIndex(index); })
      .catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load reports.");
      });
    return () => controller.abort();
  }, [attempt]);

  // Every tab uses the same date, even when a writer has no report for that day.
  const day = index?.[0];
  return (
    <div className="app-container">
      <div className="app-content">
        <div className="title-bar"><div className="title-bar-content"><div className="app-title">ai-hourly-news</div></div></div>
        <div className="tabs-container">
          <div className="tabs" role="tablist" aria-label="Article writers">
            {modelConfig.writers.map(writer => (
              <button
                key={writer.id}
                id={`tab-${writer.id}`}
                role="tab"
                aria-selected={activeWriterId === writer.id}
                aria-controls="writer-report"
                className={`tab ${activeWriterId === writer.id ? "active" : ""}`}
                onClick={() => setActiveWriterId(writer.id)}
              >
                <span className="tab-name">{writer.name}</span>
              </button>
            ))}
          </div>
          <div id="writer-report" role="tabpanel" aria-labelledby={`tab-${writer.id}`} className="writer-report">
            {error ? (
              <div className="error-message" role="alert">
                <h3>Error loading reports</h3><p>{error}</p>
                <button className="retry-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
              </div>
            ) : index === null ? (
              <div className="loading-container" role="status"><div className="loading-spinner" /><p>Loading reports...</p></div>
            ) : !day ? (
              <div className="loading-container" role="status"><h3>No reports yet</h3><p>Check back after the first report is published.</p></div>
            ) : (
              <WriterReport key={`${day.day}/${writer.id}`} day={day} writer={writer} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
