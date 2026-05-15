import {
  parseMarkdownInline,
  parseMarkdownLite,
  type MarkdownBlock,
  type MarkdownInline,
} from "./markdown-lite";

interface MarkdownTextProps {
  text: string;
  className: string;
}

export const MarkdownText = ({ text, className }: MarkdownTextProps): JSX.Element => (
  <div className={`markdown-text ${className}`}>
    {parseMarkdownLite(text).map((block, index) => (
      <MarkdownBlockView key={index} block={block} />
    ))}
  </div>
);

const MarkdownBlockView = ({ block }: { block: MarkdownBlock }): JSX.Element => {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.depth}` as keyof JSX.IntrinsicElements;
      return <Tag>{renderInline(block.text)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.text)}</p>;
    case "code":
      return (
        <pre className="markdown-text__code">
          <code>{block.text}</code>
        </pre>
      );
    case "ul":
      return (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote>
          {block.blocks.map((child, index) => (
            <MarkdownBlockView key={index} block={child} />
          ))}
        </blockquote>
      );
    case "table":
      return (
        <div className="markdown-text__table-wrap">
          <table>
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={index}>{renderInline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{renderInline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
  }
};

const renderInline = (text: string): JSX.Element[] =>
  parseMarkdownInline(text).map((node, index) => (
    <MarkdownInlineView key={index} node={node} />
  ));

const MarkdownInlineView = ({ node }: { node: MarkdownInline }): JSX.Element => {
  switch (node.kind) {
    case "text":
      return <>{node.text}</>;
    case "code":
      return <code className="markdown-text__inline-code">{node.text}</code>;
    case "strong":
      return <strong>{renderInlineNodes(node.children)}</strong>;
    case "em":
      return <em>{renderInlineNodes(node.children)}</em>;
    case "delete":
      return <del>{renderInlineNodes(node.children)}</del>;
    case "link": {
      const href = safeHref(node.href);
      if (href === null) return <>{renderInlineNodes(node.children)}</>;
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {renderInlineNodes(node.children)}
        </a>
      );
    }
  }
};

const renderInlineNodes = (nodes: MarkdownInline[]): JSX.Element[] =>
  nodes.map((node, index) => <MarkdownInlineView key={index} node={node} />);

const safeHref = (href: string): string | null => {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^#[A-Za-z0-9_-]+$/.test(href)) return href;
  return null;
};
