/**
 * Route Matcher - Next.js-style dynamic route matching
 *
 * Supports:
 * - [param] - matches single path segment
 * - [...param] - catch-all, matches multiple segments
 */

/**
 * Parsed route pattern
 */
export interface RoutePattern {
  /** Original pattern string, e.g., "/products/[id]" */
  pattern: string;
  /** Regex to match against actual URLs */
  regex: RegExp;
  /** Parameter names in order, e.g., ["id"] */
  paramNames: string[];
  /** Whether this is a catch-all pattern */
  isCatchAll: boolean;
  /** Number of static segments (for priority sorting) */
  staticSegmentCount: number;
  /** Number of dynamic segments */
  dynamicSegmentCount: number;
}

/**
 * Result of matching a URL against a pattern
 */
export interface RouteMatch {
  /** The pattern that matched */
  pattern: string;
  /** Extracted route parameters */
  params: Record<string, string | string[]>;
  /** Priority score (higher = more specific) */
  score: number;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a path contains dynamic segments
 */
export function isDynamicPath(path: string): boolean {
  return /\[[\w.]+\]/.test(path);
}

/**
 * Parse a stored path pattern into a RoutePattern object.
 *
 * Examples:
 * - "/products" -> exact match
 * - "/products/[id]" -> single dynamic segment
 * - "/docs/[...path]" -> catch-all
 * - "/users/[userId]/posts/[postId]" -> nested params
 */
export function parseRoutePattern(pattern: string): RoutePattern {
  const segments = pattern.split('/').filter(Boolean);
  const paramNames: string[] = [];
  let isCatchAll = false;
  let staticCount = 0;
  let dynamicCount = 0;

  const regexParts: string[] = ['^'];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Catch-all: [...slug]
    const catchAllMatch = segment.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAllMatch) {
      paramNames.push(catchAllMatch[1]);
      isCatchAll = true;
      dynamicCount++;
      // Match one or more path segments (including slashes)
      regexParts.push('/(.+)');
      continue;
    }

    // Dynamic segment: [slug]
    const dynamicMatch = segment.match(/^\[(\w+)\]$/);
    if (dynamicMatch) {
      paramNames.push(dynamicMatch[1]);
      dynamicCount++;
      // Match single segment (no slashes)
      regexParts.push('/([^/]+)');
      continue;
    }

    // Static segment
    staticCount++;
    regexParts.push('/' + escapeRegex(segment));
  }

  // Handle root path
  if (segments.length === 0) {
    regexParts.push('/');
  }

  // End of path (with optional trailing slash) for non-catch-all
  if (!isCatchAll) {
    regexParts.push('/?$');
  } else {
    regexParts.push('$');
  }

  return {
    pattern,
    regex: new RegExp(regexParts.join('')),
    paramNames,
    isCatchAll,
    staticSegmentCount: staticCount,
    dynamicSegmentCount: dynamicCount,
  };
}

/**
 * Calculate priority score for a pattern.
 * Higher score = more specific match.
 *
 * Rules:
 * - Exact match (no dynamic): 1000
 * - Each static segment: +10
 * - Each [param]: +5
 * - Catch-all [...param]: +1
 */
function calculateScore(routePattern: RoutePattern): number {
  // Exact match gets highest priority
  if (routePattern.paramNames.length === 0) {
    return 1000 + routePattern.staticSegmentCount * 10;
  }

  let score = routePattern.staticSegmentCount * 10;
  score += (routePattern.dynamicSegmentCount - (routePattern.isCatchAll ? 1 : 0)) * 5;

  if (routePattern.isCatchAll) {
    score += 1;
  }

  return score;
}

/**
 * Check if a URL path matches a route pattern.
 * Returns match result with extracted params, or null if no match.
 */
export function matchRoute(urlPath: string, routePattern: RoutePattern): RouteMatch | null {
  const match = urlPath.match(routePattern.regex);
  if (!match) {
    return null;
  }

  const params: Record<string, string | string[]> = {};

  for (let i = 0; i < routePattern.paramNames.length; i++) {
    const paramName = routePattern.paramNames[i];
    const value = match[i + 1];

    if (routePattern.isCatchAll && i === routePattern.paramNames.length - 1) {
      // For catch-all, split the value into array
      params[paramName] = value.split('/');
    } else {
      params[paramName] = value;
    }
  }

  return {
    pattern: routePattern.pattern,
    params,
    score: calculateScore(routePattern),
  };
}

/**
 * Find all matching patterns for a URL from a list of stored paths.
 * Returns matches sorted by priority (most specific first).
 */
export function findMatchingRoutes(urlPath: string, storedPaths: string[]): RouteMatch[] {
  const matches: RouteMatch[] = [];

  for (const storedPath of storedPaths) {
    const routePattern = parseRoutePattern(storedPath);
    const match = matchRoute(urlPath, routePattern);

    if (match) {
      matches.push(match);
    }
  }

  // Sort by score descending (highest priority first)
  matches.sort((a, b) => b.score - a.score);

  return matches;
}

/**
 * Convert a VFS path pattern to a userScripts API match pattern.
 * Dynamic segments become wildcards.
 *
 * Examples:
 * - "/products" -> "*://domain/products*"
 * - "/products/[id]" -> "*://domain/products/*"
 * - "/docs/[...path]" -> "*://domain/docs/*"
 */
export function vfsPatternToMatchPattern(domain: string, vfsPath: string): string {
  // Replace [...param] and [param] with *
  const matchPath = vfsPath
    .replace(/\[\.\.\.[\w]+\]/g, '*') // catch-all
    .replace(/\[[\w]+\]/g, '*'); // single param

  return `*://${domain}${matchPath}*`;
}

/**
 * Generate JavaScript code that extracts route params from the current URL.
 * Returns code that sets window.__routeParams.
 */
export function generateParamExtractionCode(pattern: string): string {
  const routePattern = parseRoutePattern(pattern);

  // If no dynamic segments, no extraction needed
  if (routePattern.paramNames.length === 0) {
    return '';
  }

  return `
(function() {
  var pattern = ${JSON.stringify(pattern)};
  var paramNames = ${JSON.stringify(routePattern.paramNames)};
  var regex = ${routePattern.regex.toString()};
  var isCatchAll = ${routePattern.isCatchAll};

  var urlPath = window.location.pathname;
  var match = urlPath.match(regex);

  if (!match) {
    console.log('[VFS] Route pattern mismatch, skipping:', pattern, 'for URL:', urlPath);
    return false;
  }

  var params = {};
  for (var i = 0; i < paramNames.length; i++) {
    var value = match[i + 1];
    if (isCatchAll && i === paramNames.length - 1) {
      params[paramNames[i]] = value.split('/');
    } else {
      params[paramNames[i]] = value;
    }
  }

  window.__routeParams = window.__routeParams || {};
  Object.assign(window.__routeParams, params);
  console.log('[VFS] Route params extracted:', params);
  return true;
})()`;
}

/**
 * Wrap a user script with route param extraction and validation.
 * The wrapper:
 * 1. Validates the current URL matches the pattern
 * 2. Extracts params from the URL
 * 3. Sets window.__routeParams
 * 4. Executes the actual script only if pattern matches
 */
export function wrapScriptWithParamExtraction(script: string, pattern: string): string {
  const routePattern = parseRoutePattern(pattern);

  // If no dynamic segments, return script as-is
  if (routePattern.paramNames.length === 0) {
    return script;
  }

  const extractionCode = generateParamExtractionCode(pattern);

  return `
(function() {
  // Route param extraction and validation
  var shouldRun = ${extractionCode};

  if (shouldRun === false) {
    return;
  }

  // Execute actual script
  ${script}
})();
`;
}
