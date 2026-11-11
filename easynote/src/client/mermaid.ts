import mermaid, { type MermaidConfig } from 'mermaid';
import DOMPurify from 'dompurify';

const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function diagramConfig(dark: boolean): MermaidConfig {
  const background = dark ? '#173650' : '#dff0ff';
  const text = dark ? '#d8edff' : '#004f99';
  const border = dark ? '#4f789b' : '#ced8e1';
  const labelBackground = dark ? '#253747' : '#f5faff';
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 50_000,
    maxEdges: 500,
    secure: [
      'secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges',
      'theme', 'look', 'layout', 'themeVariables', 'themeCSS', 'fontFamily', 'htmlLabels', 'dompurifyConfig',
    ],
    theme: dark ? 'redux-dark-color' : 'redux-color',
    look: 'neo',
    fontFamily,
    themeVariables: {
      fontFamily, fontSize: '14px',
      nodeShadow: false, dropShadow: '', useGradient: false, strokeWidth: 1,
      mainBkg: background, primaryColor: background,
      primaryTextColor: text, nodeTextColor: text, textColor: text,
      primaryBorderColor: border, nodeBorder: border,
      lineColor: dark ? '#a6afb8' : '#8f8f8f',
      edgeLabelBackground: labelBackground, labelBackgroundColor: labelBackground,
    },
    themeCSS: `
      .node, .node rect, .node circle, .node ellipse, .node polygon, .node path, .cluster rect { filter: none; }
      .node rect.basic.label-container { rx: 16px; ry: 16px; stroke-width: 1px; }
      .node text, .node tspan[font-weight="normal"], .edgeLabels text, .edgeLabels tspan[font-weight="normal"] { font-weight: 600; }
      .edgeLabels text { font-size: 13px; }
      .edgeLabel .label rect { rx: 10px; ry: 10px; fill: ${labelBackground}; stroke: ${border}; stroke-width: 1px; opacity: 1; }
      .edge-thickness-normal { stroke-width: 1px; }
      .flowchart-link { stroke-linecap: round; stroke-linejoin: round; }
    `,
    flowchart: {
      layout: 'elk',
      htmlLabels: false,
      useMaxWidth: false,
      diagramPadding: 16,
      padding: 16,
      wrappingWidth: 240,
      nodeSpacing: 50,
      rankSpacing: 60,
      curve: 'basis',
    },
  };
}

// Mermaid's configuration is global: keep theme setup and rendering in the same queue.
let pending = Promise.resolve();
export function renderDiagram(source: string, dark: boolean) {
  const job = pending.then(async () => {
    await document.fonts.ready;
    mermaid.initialize(diagramConfig(dark));
    const result = await mermaid.render(`easynote-diagram-${crypto.randomUUID()}`, source);
    const svg = DOMPurify.sanitize(result.svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['style'],
    });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (result.diagramType.startsWith('flowchart')) {
      // Replace filled flowchart arrowheads with small open chevrons; other marker types keep their meaning.
      for (const marker of parsed.querySelectorAll('marker[id*="-pointEnd"], marker[id*="-pointStart"]')) {
        const start = marker.id.includes('-pointStart');
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('refX', start ? '2' : '8');
        marker.setAttribute('refY', '5');
        const path = parsed.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', start ? 'M 8 2 L 2 5 L 8 8' : 'M 2 2 L 8 5 L 2 8');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', dark ? '#a6afb8' : '#8f8f8f');
        path.setAttribute('stroke-width', '1.25');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        marker.replaceChildren(path);
      }
    }
    return { ...result, svg: new XMLSerializer().serializeToString(parsed.documentElement) };
  });
  // A malformed block must not prevent later diagrams from rendering.
  pending = job.then(() => undefined, () => undefined);
  return job;
}
