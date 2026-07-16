ParserVo Stone Island Capture 2.4.0

Versioned Stone Island-only capture agent for ParserVo.

Validated behavior:
- accepts only real Stone Island product URLs ending in a full L... style/color code;
- SKU is read from the product URL, not from the COMPLIMENTARY SHIPPING banner;
- captures current price and compare-at price separately;
- preserves the exact selected color;
- opens and waits for the dynamic size selector;
- excludes sold-out sizes;
- uses the exact inventory quantity configured in ParserVo;
- imports only THRON images containing the exact product code;
- reports queue cancellation and Shopify errors explicitly.

Installation:
1. Open chrome://extensions
2. Enable Developer mode
3. Remove the old ParserVo Capture extension
4. Click Load unpacked and select this chrome-extension folder
5. Save API Base URL, Shop and Browser Capture Token
6. Click Test API connection and Start queue now
