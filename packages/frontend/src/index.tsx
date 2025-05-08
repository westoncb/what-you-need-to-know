import React from "react";
import ReactDOM from "react-dom/client";

import App from "./components/App";
import "./index.css";           // Tailwind will inject its base styles

// Root element is defined in packages/frontend/index.html
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
