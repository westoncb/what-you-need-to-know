import React, { useState, useEffect } from "react";
import Article from "./Article";
import "./App.css";

const AI_MODELS = [
  {
    id: "claude-3-7",
    name: "Claude Sonnet 3.7",
    image: "/images/claude-3-7.png",
    banner: "/images/claude-banner.jpg" // Path to the banner you generated
  },
  {
    id: "gpt-4-5",
    name: "GPT-4.5",
    image: "/images/gpt-4-5.png",
    banner: "/images/gpt-banner.jpg" // You'll need to generate this
  },
  {
    id: "gemini-flash",
    name: "Gemini Flash 2.5",
    image: "/images/gemini-flash.png",
    banner: "/images/gemini-banner.jpg" // You'll need to generate this
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState(AI_MODELS[0].id);
  const [reports, setReports] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Helper function to get local date in YYYY-MM-DD format
  const getLocalDateString = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  useEffect(() => {
    const fetchReports = async () => {
      try {
        setLoading(true);
        const dateString = getLocalDateString();
        console.log(`Fetching reports for local date: ${dateString}`);

        // Fetch reports for all models
        const reportData = {};

        // For demonstration, we're just loading one report and duplicating it
        // In production, you'd fetch different reports for different models
        const response = await fetch(`/data/${dateString}.json`);

        if (!response.ok) {
          throw new Error(`Failed to fetch report: ${response.status}`);
        }

        const data = await response.json();

        // Duplicate the same report for all models (for demonstration)
        AI_MODELS.forEach(model => {
          const fixedItems = []
          console.log("DATA", data)
          data.items.forEach(item => {
            const subItem = item.item;
            console.log("sub:",subItem)
            fixedItems.push({ context: item.context, overview: item.overview, why: item.why, ...subItem});
          });
          reportData[model.id] = {...data, items: [...fixedItems]};
        });

        setReports(reportData);
        setLoading(false);
      } catch (err) {
        console.error("Error loading reports:", err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchReports();
  }, []);

  // In App.jsx, update the return statement to:

  return (
    <div className="app-container">
      <div className="app-content">
        <div className="title-bar">
          <div className="title-bar-content">
            <div className="app-title">ai-hourly-news</div>
            <a href="/about" className="about-link">about</a>
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

          <div className="tab-content">
            {loading ? (
              <div className="loading-container">
                <div className="loading-spinner"></div>
                <p>Loading reports...</p>
              </div>
            ) : error ? (
              <div className="error-message">
                <h3>Error loading reports</h3>
                <p>{error}</p>
              </div>
            ) : (
              <div className="article-frame">
                <Article report={reports[activeTab]} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
