// Save this as a separate file - json-validator.js

/**
 * Validates and sanitizes JSON text
 * @param {string} jsonText - The JSON text to validate
 * @returns {Object|null} - Parsed JSON object or null if invalid
 */
export function validateAndFixJSON(jsonText) {
  try {
    // First try direct parsing
    return JSON.parse(jsonText);
  } catch (err) {
    console.error("Initial JSON parse failed:", err);

    // Log the problematic text (first 200 chars)
    console.log("Problematic JSON (start):", jsonText.substring(0, 200));

    try {
      // Try to fix common issues:

      // 1. Trim whitespace
      const trimmed = jsonText.trim();

      // 2. Check if it starts with <!DOCTYPE or <html (common 404 page)
      if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
        console.error("Received HTML instead of JSON");
        return null;
      }

      // 3. Try to find where the JSON actually starts (if there's junk at the beginning)
      const jsonStart = trimmed.indexOf('{');
      if (jsonStart > 0) {
        console.log(`Found JSON starting at position ${jsonStart}`);
        const potentialJson = trimmed.substring(jsonStart);
        return JSON.parse(potentialJson);
      }

      // If we got here, we couldn't fix it
      return null;
    } catch (fixErr) {
      console.error("Could not fix JSON:", fixErr);
      return null;
    }
  }
}

/**
 * Uses fetch to get JSON and properly validates the response
 * @param {string} url - URL to fetch
 * @returns {Promise<Object>} - Parsed JSON data
 */
export async function fetchAndValidateJSON(url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Read as text first
    const text = await response.text();

    // Then validate and parse the JSON
    const data = validateAndFixJSON(text);

    if (!data) {
      throw new Error("Invalid JSON received");
    }

    return data;
  } catch (error) {
    console.error("Error fetching or parsing JSON:", error);
    throw error;
  }
}
