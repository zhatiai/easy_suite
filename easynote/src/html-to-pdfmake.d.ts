declare module 'html-to-pdfmake' {
  interface HtmlToPdfmakeOptions {
    window?: Window;
    tableAutoSize?: boolean;
    removeExtraBlanks?: boolean;
    defaultStyles?: Record<string, Record<string, unknown>>;
    customTag?: (params: { element: Element; parents: Element[]; ret: Record<string, unknown> }) => Record<string, unknown> | undefined;
  }

  export default function htmlToPdfmake(html: string, options?: HtmlToPdfmakeOptions): unknown;
}
