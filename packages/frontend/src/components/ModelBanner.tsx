import React from 'react';
import './ModelBanner.css';

const ModelBanner = ({ model }) => {
  // Default values in case model props aren't fully provided
  const modelName = model?.name || 'AI Model';
  const imagePath = model?.banner || `${import.meta.env.BASE_URL}images/default-banner.jpg`;

  return (
    <div className="model-stamp">
      <div
        className="stamp-image"
        style={{ backgroundImage: `url(${imagePath})` }}
      ></div>
      {/* <div className="stamp-label">{modelName}</div> */}
    </div>
  );
};

export default ModelBanner;
