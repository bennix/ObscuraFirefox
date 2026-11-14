// NW.js advertises Chromium without the Google Chrome brand. Sites that expect a
// normal Chrome login surface reject that pair. Keep the real version and platform.
function chromeClientHints(probe) {
  const ua = String(probe?.ua || '');
  const major = (ua.match(/Chrome\/(\d+)/) || [])[1];
  if (!major) return null;
  const brands = Array.isArray(probe.brands) ? probe.brands.filter(item => item && typeof item.brand === 'string') : [];
  if (brands.some(item => item.brand === 'Google Chrome')) return null;
  const chromium = brands.find(item => item.brand === 'Chromium');
  const grease = brands.find(item => /not.?a.?brand/i.test(item.brand)) || { brand: 'Not-A.Brand', version: '24' };
  const version = String(chromium?.version || major);
  const full = /^\d+\.\d+\.\d+\.\d+$/.test(probe.fullVersion) ? probe.fullVersion : `${major}.0.0.0`;
  const greaseVersion = String(grease.version || '24');
  return {
    userAgent: ua,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version },
        { brand: 'Google Chrome', version },
        { brand: grease.brand, version: greaseVersion }
      ],
      fullVersionList: [
        { brand: 'Chromium', version: full },
        { brand: 'Google Chrome', version: full },
        { brand: grease.brand, version: `${greaseVersion}.0.0.0` }
      ],
      platform: typeof probe.platformName === 'string' && probe.platformName ? probe.platformName : 'macOS',
      platformVersion: String(probe.platformVersion || ''),
      architecture: String(probe.architecture || ''),
      model: String(probe.model || ''),
      mobile: probe.mobile === true,
      bitness: String(probe.bitness || ''),
      wow64: probe.wow64 === true
    }
  };
}

module.exports = { chromeClientHints };
