"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, Node } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import CharacterCount from "@tiptap/extension-character-count";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold, Italic, List, ListOrdered, Heading1, Heading2, Undo, Redo, Printer,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Mic, Settings, Palette, PenTool, FileText
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useEffect, useRef } from "react";
// jsPDF is imported here for the direct export, but we use CDNs for the preview window
import jsPDF from 'jspdf'; 

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────
const PAGE_WIDTH_MM = 215.9;
const PAGE_HEIGHT_MM = 279.4;
const MARGIN_TOP_BOTTOM_MM = 35.4;     
const MARGIN_LEFT_RIGHT_MM = 30.4;     
const PX_PER_MM = 3.7795;
const PAGE_CONTENT_HEIGHT_PX = (PAGE_HEIGHT_MM * PX_PER_MM) - (2 * (MARGIN_TOP_BOTTOM_MM * PX_PER_MM));

// Approximate average space width multiplier
const AVG_SPACE_WIDTH_FACTOR = 0.25; 

// Templates
const templates: Record<string, string> = {
  officialLetter: `<h1>[Company Name]</h1>
<p>[Your Address]<br>[City, State ZIP]<br>[Email] | [Phone]<br>[Date]</p>
<p>[Recipient Name]<br>[Recipient Title]<br>[Company Name]<br>[Address]</p>
<p>Subject: [Subject Line]</p>
<p>Dear [Recipient],</p>
<p>[Body of letter...]</p>
<p>Sincerely,<br>[Your Name]<br>[Your Title]</p>`,
};

// Custom Page Break Node
const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  parseHTML() { return [{ tag: 'div[data-type="page-break"]' }]; },
  renderHTML() {
    return ['div', { 'data-type': 'page-break', class: 'page-break' }];
  },
});

// Custom Spacer Node
const Spacer = Node.create({
  name: 'spacer',
  group: 'block',
  atom: true,
  // FIXED: Removed 'isLeaf: true' to solve build error. 
  // 'atom: true' is sufficient for Tiptap to treat it as a leaf.
  draggable: true,
  attrs: { height: { default: 0 } },
  parseHTML() {
    return [{
      tag: 'div[data-type="spacer"]',
      getAttrs: (el: any) => ({ height: parseFloat(el.style.height) || 0 }),
    }];
  },
  renderHTML({ attrs = {} }) {
    const height = attrs.height ?? 0;
    return ['div', { 'data-type': 'spacer', style: `height: ${height}px; min-height: ${height}px;` }];
  },
});

// Free Cursor Extension
const FreeCursor = Extension.create({
  name: 'freeCursor',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick(view, pos, event) {
            const doc = view.state.doc;
            const pmRect = view.dom.getBoundingClientRect();
            const paddingLeft = parseFloat(getComputedStyle(view.dom).paddingLeft);
            const paddingRight = parseFloat(getComputedStyle(view.dom).paddingRight);
            const contentWidth = pmRect.width - paddingLeft - paddingRight;

            // Ignore clicks in dead zones
            if (
              event.clientX < pmRect.left + paddingLeft ||
              event.clientX > pmRect.left + paddingLeft + contentWidth
            ) {
              return true; 
            }

            const coordResult = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!coordResult) return false;
            const { pos: clickPos, inside } = coordResult;

            if (inside >= 0) {
              const tr = view.state.tr;
              tr.setSelection(TextSelection.create(doc, clickPos));
              view.dispatch(tr);
              view.focus();
              return true;
            }

            if (clickPos >= doc.content.size) {
              const endCoord = view.coordsAtPos(doc.content.size);
              const addHeight = event.clientY - endCoord.top;
              if (addHeight > 0) {
                const tr = view.state.tr;
                const spacer = view.state.schema.nodes.spacer.create({ height: addHeight });
                const horizontalOffsetPx = event.clientX - pmRect.left - paddingLeft;
                const fontSizePt = parseInt(getComputedStyle(view.dom).fontSize) || 12;
                const spaceWidthPx = fontSizePt * AVG_SPACE_WIDTH_FACTOR;
                const numSpaces = Math.floor(horizontalOffsetPx / spaceWidthPx);
                const paddingSpaces = '\u00A0'.repeat(numSpaces);

                const para = view.state.schema.nodes.paragraph.create(null, view.state.schema.text(paddingSpaces));
                tr.insert(doc.content.size, [spacer, para]);
                const cursorPos = doc.content.size + spacer.nodeSize + numSpaces + 1;
                tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                view.dispatch(tr);
                view.focus();
                return true;
              }
              return false;
            }

            const nodeAt = doc.nodeAt(clickPos);
            if (nodeAt && nodeAt.type.name === 'spacer') {
              const dom = view.nodeDOM(clickPos);
              if (!dom) return false;
              const rect = (dom as HTMLElement).getBoundingClientRect();
              const relativeY = event.clientY - rect.top;
              const totalH = nodeAt.attrs.height;

              if (relativeY >= 0 && relativeY <= totalH) {
                const tr = view.state.tr;
                const spacerAbove = relativeY > 0 ? view.state.schema.nodes.spacer.create({ height: relativeY }) : null;
                const spacerBelow = (totalH - relativeY) > 0 ? view.state.schema.nodes.spacer.create({ height: totalH - relativeY }) : null;
                const horizontalOffsetPx = event.clientX - rect.left;
                const fontSizePt = parseInt(getComputedStyle(view.dom).fontSize) || 12;
                const spaceWidthPx = fontSizePt * AVG_SPACE_WIDTH_FACTOR;
                const numSpaces = Math.floor(horizontalOffsetPx / spaceWidthPx);
                const paddingSpaces = '\u00A0'.repeat(numSpaces);

                const para = view.state.schema.nodes.paragraph.create(null, view.state.schema.text(paddingSpaces));
                const fragment: any[] = [];
                if (spacerAbove) fragment.push(spacerAbove);
                fragment.push(para);
                if (spacerBelow) fragment.push(spacerBelow);
                tr.replaceWith(clickPos, clickPos + nodeAt.nodeSize, fragment);

                let offset = 0;
                if (spacerAbove) offset += spacerAbove.nodeSize;
                const paraStart = clickPos + offset;
                const cursorPos = paraStart + numSpaces + 1;
                tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                view.dispatch(tr);
                view.focus();
                return true;
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});

// ──────────────────────────────────────────────
// Menu Bar Component
// ──────────────────────────────────────────────
const MenuBar = ({ editor, title, setTitle, fontFamily, setFontFamily, fontSize, setFontSize, drawingMode, toggleDrawingMode, toggleTemplateDialog }: any) => {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = true;

    recognitionRef.current.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0])
        .map((result: any) => result.transcript)
        .join('');
      editor?.commands.insertContent(transcript);
    };
  }, [editor]);

  const toggleDictation = () => {
    if (!editor) return;
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      recognitionRef.current?.start();
    }
    setIsListening(prev => !prev);
  };

  const cleanHTML = (html: string) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll('.page-break, [data-type="page-break"]').forEach(el => el.remove());
    return tempDiv.innerHTML;
  };

  // ──────────────────────────────────────────────
  // PREVIEW WINDOW LOGIC (With Visual Pagination)
  // ──────────────────────────────────────────────
  const handlePrintPreview = () => {
    if (!editor) return;
    
    // 1. Prepare Content
    const content = editor.getHTML();
    const cleanContent = cleanHTML(content);
    
    // 2. Open Window
    const printWindow = window.open("", "_blank", "width=900,height=800,scrollbars=yes");
    if (!printWindow) return;

    // 3. Calculate Pages (Simulate Pagination)
    const pageContentHeight = PAGE_CONTENT_HEIGHT_PX;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = cleanContent;
    // Set styles for measurement matching the output
    tempDiv.style.width = `${PAGE_WIDTH_MM - 2 * MARGIN_LEFT_RIGHT_MM}mm`;
    tempDiv.style.fontFamily = fontFamily;
    tempDiv.style.fontSize = `${fontSize}pt`;
    tempDiv.style.visibility = 'hidden';
    document.body.appendChild(tempDiv);

    let pages: string[] = [];
    let currentPage = '';
    let currentHeight = 0;

    Array.from(tempDiv.childNodes).forEach((node: any) => {
      const clone = node.cloneNode(true);
      const measurer = document.createElement('div');
      measurer.appendChild(clone);
      measurer.style.position = 'absolute';
      measurer.style.visibility = 'hidden';
      measurer.style.width = tempDiv.style.width;
      measurer.style.fontFamily = tempDiv.style.fontFamily;
      measurer.style.fontSize = tempDiv.style.fontSize;
      measurer.style.lineHeight = '1.5';
      document.body.appendChild(measurer);
      const h = measurer.offsetHeight || 20;
      document.body.removeChild(measurer);

      if (currentHeight + h > pageContentHeight && currentPage) {
        pages.push(currentPage);
        currentPage = '';
        currentHeight = 0;
      }
      currentPage += node.outerHTML || '';
      currentHeight += h;
    });
    if (currentPage) pages.push(currentPage);
    document.body.removeChild(tempDiv);

    // 4. Construct Preview HTML
    // We add Scripts for jsPDF and html2canvas via CDN so the popup works independently
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title || "Document"} - Preview</title>
          <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
          <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
          <style>
            @page { size: letter; margin: 0; }
            body {
              background: #525659;
              margin: 0;
              padding: 20px;
              display: flex;
              flex-direction: column;
              align-items: center;
              font-family: sans-serif;
            }
            .toolbar {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              background: #333;
              color: white;
              padding: 10px 20px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              z-index: 1000;
              box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            }
            .page-wrapper {
              margin-top: 60px; /* Space for toolbar */
            }
            .page-container {
              width: ${PAGE_WIDTH_MM}mm;
              height: ${PAGE_HEIGHT_MM}mm;
              background: white;
              margin-bottom: 20px;
              box-shadow: 0 4px 8px rgba(0,0,0,0.2);
              position: relative;
              overflow: hidden;
            }
            .content-area {
              padding: ${MARGIN_TOP_BOTTOM_MM}mm ${MARGIN_LEFT_RIGHT_MM}mm;
              height: 100%;
              box-sizing: border-box;
              font-family: '${fontFamily}', serif;
              font-size: ${fontSize}pt;
              line-height: 1.5;
              color: #000;
            }
            .page-number {
              position: absolute;
              bottom: 15mm;
              left: 0;
              right: 0;
              text-align: center;
              font-size: 10pt;
              color: #888;
            }
            /* Styling for content to match editor */
            p, h1, h2, h3, ul, ol { margin-bottom: 0.5em; margin-top: 0; }
            h1 { font-size: 2em; font-weight: bold; }
            h2 { font-size: 1.5em; font-weight: bold; }
            img { max-width: 100%; height: auto; }
            
            button {
              background: #007bff;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              font-weight: bold;
            }
            button:hover { background: #0056b3; }
            button.secondary { background: #6c757d; margin-right: 10px; }
            
            /* Print Specifics to hide toolbar */
            @media print {
              .toolbar { display: none; }
              body { background: white; padding: 0; }
              .page-wrapper { margin-top: 0; }
              .page-container { box-shadow: none; margin-bottom: 0; page-break-after: always; }
            }
          </style>
        </head>
        <body>
          <div class="toolbar">
            <span>${title || "Document Preview"}</span>
            <div>
              <button class="secondary" onclick="window.print()">Print</button>
              <button id="export-pdf-btn">Export PDF</button>
            </div>
          </div>

          <div id="document-content" class="page-wrapper">
            ${pages.map((p, i) => `
              <div class="page-container">
                <div class="content-area">${p}</div>
                <div class="page-number">Page ${i + 1}</div>
              </div>
            `).join('')}
          </div>

          <script>
            document.getElementById('export-pdf-btn').addEventListener('click', async () => {
              const btn = document.getElementById('export-pdf-btn');
              const originalText = btn.innerText;
              btn.innerText = "Generating...";
              btn.disabled = true;

              try {
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF({
                  orientation: 'portrait',
                  unit: 'mm',
                  format: 'letter'
                });

                const element = document.getElementById('document-content');
                
                // We use html2canvas to render the visual layout exactly
                await doc.html(element, {
                  callback: function(pdf) {
                    pdf.save('${title || 'document'}.pdf');
                    btn.innerText = "Done!";
                    setTimeout(() => { 
                      btn.innerText = originalText; 
                      btn.disabled = false; 
                    }, 2000);
                  },
                  x: 0,
                  y: 0,
                  width: ${PAGE_WIDTH_MM}, // Width of the PDF page
                  windowWidth: 1000, // Ensure desktop rendering
                  html2canvas: {
                    scale: 0.264583, // Scale to match mm (approx 96dpi)
                    useCORS: true,
                    scrollY: 0
                  },
                  margin: [0, 0, 0, 0], // Margins are already handled by CSS padding in .content-area
                  autoPaging: 'text'
                });

              } catch (err) {
                console.error(err);
                alert("Error generating PDF: " + err.message);
                btn.innerText = originalText;
                btn.disabled = false;
              }
            });
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // ──────────────────────────────────────────────
  // DIRECT EXPORT TO PDF (Main Page Button)
  // ──────────────────────────────────────────────
  // Updated with Pixel-to-MM mapping to prevent empty pages/cutoff
  const handleExportPDF = async () => {
    if (!editor) return;

    // 1. Setup jsPDF
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'letter' // [215.9, 279.4]
    });

    // 2. Prepare content
    const content = cleanHTML(editor.getHTML());
    
    // 3. Create a temporary container for rendering
    // We use PX here to ensure the browser layout engine renders it exactly as seen on screen.
    // 1 mm = 3.7795 px (at 96 DPI)
    const contentWidthMM = PAGE_WIDTH_MM - (2 * MARGIN_LEFT_RIGHT_MM); // ~155.1mm
    const contentWidthPX = contentWidthMM * 3.7795; // Convert to pixels for the DOM element

    const tempContainer = document.createElement('div');
    tempContainer.style.width = `${contentWidthPX}px`; 
    tempContainer.style.padding = '0';
    tempContainer.style.margin = '0';
    tempContainer.style.background = '#ffffff';
    tempContainer.style.fontFamily = fontFamily;
    tempContainer.style.fontSize = `${fontSize}pt`;
    // Ensure text wraps exactly like the editor
    tempContainer.style.lineHeight = '1.5';
    tempContainer.style.color = '#000000';
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '0';
    // Vital: Allow height to expand infinitely so html2canvas sees everything
    tempContainer.style.height = 'auto'; 
    tempContainer.style.overflow = 'visible';

    // Inject styles
    tempContainer.innerHTML = `
      <style>
        p { margin-bottom: 0.5em; margin-top: 0; }
        h1 { font-size: 2em; font-weight: bold; margin-bottom: 0.5em; margin-top: 0; }
        h2 { font-size: 1.5em; font-weight: bold; margin-bottom: 0.5em; margin-top: 0; }
        ul, ol { margin-left: 1.5em; margin-bottom: 0.5em; }
        img { max-width: 100%; height: auto; }
      </style>
      ${content}
    `;

    document.body.appendChild(tempContainer);

    // 4. Render
    // We tell jsPDF: "Take this HTML (rendered at windowWidth pixels) and fit it into 'width' mm on the PDF"
    await doc.html(tempContainer, {
      callback: (pdf) => {
        pdf.save(`${title || 'document'}.pdf`);
        document.body.removeChild(tempContainer); 
      },
      x: MARGIN_LEFT_RIGHT_MM,
      y: MARGIN_TOP_BOTTOM_MM,
      width: contentWidthMM, // Target width in the PDF (155.1mm)
      windowWidth: contentWidthPX, // Input width in pixels (ensures layout matches)
      margin: [MARGIN_TOP_BOTTOM_MM, MARGIN_LEFT_RIGHT_MM, MARGIN_TOP_BOTTOM_MM, MARGIN_LEFT_RIGHT_MM],
      autoPaging: 'text',
      html2canvas: {
        scale: 1, // Let jsPDF calculate the scale based on the width parameter
        useCORS: true,
        logging: false,
        letterRendering: true, // Improves font rendering
      }
    });
  };

  if (!editor) {
    return (
      <div className="w-full max-w-[215.9mm] mx-auto bg-white border-b shadow-sm sticky top-0 z-50 p-4 text-center text-gray-500">
        Loading editor...
      </div>
    );
  }

  return (
    <div className="w-full max-w-[215.9mm] mx-auto bg-white border-b shadow-sm sticky top-0 z-50">
      <div className="flex items-center justify-between px-4 py-1 flex-wrap">
        <Input
          placeholder="My Legal Document"
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-64 border-none focus:ring-0 text-lg font-medium"
        />

        <div className="flex items-center gap-1">
          <Toggle size="sm" pressed={editor.isActive("bold")} onPressedChange={() => editor.chain().focus().toggleBold().run()} disabled={!editor}>
            <Bold className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive("italic")} onPressedChange={() => editor.chain().focus().toggleItalic().run()} disabled={!editor}>
            <Italic className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive("heading", { level: 1 })} onPressedChange={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} disabled={!editor}>
            <Heading1 className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive("heading", { level: 2 })} onPressedChange={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} disabled={!editor}>
            <Heading2 className="h-4 w-4" />
          </Toggle>
          <Separator orientation="vertical" className="h-6 mx-1" />
          <Toggle size="sm" pressed={editor.isActive("bulletList")} onPressedChange={() => editor.chain().focus().toggleBulletList().run()} disabled={!editor}>
            <List className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive("orderedList")} onPressedChange={() => editor.chain().focus().toggleOrderedList().run()} disabled={!editor}>
            <ListOrdered className="h-4 w-4" />
          </Toggle>
          <Separator orientation="vertical" className="h-6 mx-1" />
          <Toggle size="sm" pressed={editor.isActive({ textAlign: "left" })} onPressedChange={() => editor.chain().focus().setTextAlign("left").run()} disabled={!editor}>
            <AlignLeft className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive({ textAlign: "center" })} onPressedChange={() => editor.chain().focus().setTextAlign("center").run()} disabled={!editor}>
            <AlignCenter className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive({ textAlign: "right" })} onPressedChange={() => editor.chain().focus().setTextAlign("right").run()} disabled={!editor}>
            <AlignRight className="h-4 w-4" />
          </Toggle>
          <Toggle size="sm" pressed={editor.isActive({ textAlign: "justify" })} onPressedChange={() => editor.chain().focus().setTextAlign("justify").run()} disabled={!editor}>
            <AlignJustify className="h-4 w-4" />
          </Toggle>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
            <Undo className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
            <Redo className="h-4 w-4" />
          </Button>
          <Separator orientation="vertical" className="h-6" />
          
          <Button variant="outline" size="sm" onClick={handlePrintPreview}>
            <Printer className="h-4 w-4 mr-2" />Preview & PDF
          </Button>
          
          <Button variant="outline" size="sm" onClick={handleExportPDF}>
            <FileText className="h-4 w-4 mr-2" />PDF (Direct)
          </Button>

          <Button variant="outline" size="sm" onClick={toggleDictation} disabled={!editor}>
            <Mic className="h-4 w-4 mr-2" />{isListening ? "Stop" : "Dictate"}
          </Button>
          <Button 
            variant={drawingMode ? "secondary" : "outline"} 
            size="sm" 
            onClick={toggleDrawingMode}
            className={drawingMode ? "bg-blue-100 border-blue-300" : ""}
          >
            <PenTool className="h-4 w-4 mr-2" />{drawingMode ? "Stop Draw" : "Draw"}
          </Button>
          <Button variant="outline" size="sm" onClick={toggleTemplateDialog}>
            <Palette className="h-4 w-4 mr-2" />Design
          </Button>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div>
                  <label>Font Family</label>
                  <Select value={fontFamily} onValueChange={setFontFamily}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Times New Roman">Times New Roman</SelectItem>
                      <SelectItem value="Georgia">Georgia</SelectItem>
                      <SelectItem value="Arial">Arial</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label>Font Size (pt)</label>
                  <Input type="number" value={fontSize} onChange={e => setFontSize(parseInt(e.target.value) || 12)} min={8} max={72} />
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// Main Editor Component
// ──────────────────────────────────────────────
export default function Editors() {
  const [title, setTitle] = useState("");
  const [fontFamily, setFontFamily] = useState("Times New Roman");
  const [fontSize, setFontSize] = useState(12);
  const [drawingMode, setDrawingMode] = useState(false);
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null); // New ref for the White Page
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ──────────────────────────────────────────────
  // Real-time Pagination Plugin
  // ──────────────────────────────────────────────
  const CustomPagination = Extension.create({
    name: 'pagination',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          view(editorView) {
            return {
              update(view) {
                updatePageBreaks(view);
              },
            };
          },
        }),
      ];
    },
  });

  function updatePageBreaks(view: any) {
    const { state, dispatch } = view;
    if (!state || !dispatch) return;

    const tr = state.tr;
    const doc = state.doc;
    let cumulativeHeight = 0;
    const insertPositions: number[] = [];
    const removePositions: number[] = [];
    const currentBreakPositions: number[] = [];

    doc.descendants((node: any, pos: number) => {
      if (node.type.name === 'pageBreak') {
        currentBreakPositions.push(pos);
        removePositions.push(pos);
        return false;
      }
      if (!node.isBlock) return;

      let h: number;
      if (node.type.name === 'spacer') {
        h = node.attrs.height || 0;
      } else {
        const dom = view.nodeDOM(pos);
        if (!dom) return;
        const rect = (dom as HTMLElement).getBoundingClientRect();
        h = rect.height || 20;
      }

      if (cumulativeHeight + h > PAGE_CONTENT_HEIGHT_PX && cumulativeHeight > 0) {
        insertPositions.push(pos);
        cumulativeHeight = h;
      } else {
        cumulativeHeight += h;
      }
    });

    const sortedCurrent = [...currentBreakPositions].sort((a, b) => a - b);
    const sortedNew = [...insertPositions].sort((a, b) => a - b);
    if (JSON.stringify(sortedCurrent) === JSON.stringify(sortedNew)) {
      return;
    }

    removePositions.reverse().forEach(pos => {
      tr.delete(pos, pos + 1);
    });

    insertPositions.reverse().forEach(pos => {
      tr.insert(pos, state.schema.nodes.pageBreak.create());
    });

    if (tr.docChanged) {
      dispatch(tr.scrollIntoView());
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight,
      Image,
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start drafting your legal document...' }),
      PageBreak,
      Spacer,
      FreeCursor,
      CustomPagination,
    ],
    content: '<p></p>',
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editor && selectedTemplate) {
      editor.commands.setContent(templates[selectedTemplate] || '<p></p>', false);
    }
  }, [selectedTemplate, editor]);

  // ──────────────────────────────────────────────
  // Drawing Canvas Logic (Fixing Dead Zones)
  // ──────────────────────────────────────────────
  useEffect(() => {
    // Only run if drawing mode is active and we have refs
    if (!drawingMode || !canvasRef.current || !paperRef.current) return;

    const canvas = canvasRef.current;
    const paper = paperRef.current;
    
    // Set canvas dimensions to match the WHITE PAPER, not the screen
    canvas.width = paper.offsetWidth;
    canvas.height = paper.offsetHeight;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // CALCULATE DEAD ZONES IN PIXELS
    // We can use the logic from Constants (mm -> px)
    const deadZoneTop = MARGIN_TOP_BOTTOM_MM * PX_PER_MM;
    const deadZoneLeft = MARGIN_LEFT_RIGHT_MM * PX_PER_MM;
    const contentWidth = canvas.width - (2 * deadZoneLeft);
    const contentHeight = canvas.height - (2 * deadZoneTop);

    // CLIP THE CONTEXT
    // This physically prevents drawing outside the allowed content area (white space minus margins)
    ctx.beginPath();
    ctx.rect(deadZoneLeft, deadZoneTop, contentWidth, contentHeight);
    ctx.clip(); 

    let isDrawing = false;

    const getPos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    };

    const startDrawing = (e: MouseEvent) => {
      isDrawing = true;
      const { x, y } = getPos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };

    const stopDrawing = () => {
      isDrawing = false;
      ctx.beginPath(); // Reset path to prevent connecting separate lines
    };

    const draw = (e: MouseEvent) => {
      if (!isDrawing) return;
      const { x, y } = getPos(e);

      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000000'; // Black ink

      ctx.lineTo(x, y);
      ctx.stroke();
    };

    // Attach listeners
    canvas.addEventListener('mousedown', startDrawing);
    window.addEventListener('mouseup', stopDrawing); // Window ensures drag release detection
    canvas.addEventListener('mousemove', draw);

    return () => {
      canvas.removeEventListener('mousedown', startDrawing);
      window.removeEventListener('mouseup', stopDrawing);
      canvas.removeEventListener('mousemove', draw);
    };
  }, [drawingMode, editor]); // Re-run if drawing mode or editor changes (resizes)

  const handleInsertDrawing = () => {
    if (!canvasRef.current || !editor) return;
    // Current approach converts whole canvas. 
    // Ideally, crop to content, but this works for basic usage.
    const dataUrl = canvasRef.current.toDataURL('image/png');
    editor.commands.setImage({ src: dataUrl });
    setDrawingMode(false);
    
    // Clear canvas
    const ctx = canvasRef.current.getContext('2d');
    ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-200">
      <MenuBar
        editor={editor}
        title={title} setTitle={setTitle}
        fontFamily={fontFamily} setFontFamily={setFontFamily}
        fontSize={fontSize} setFontSize={setFontSize}
        drawingMode={drawingMode}
        toggleDrawingMode={() => setDrawingMode(!drawingMode)}
        toggleTemplateDialog={() => setIsTemplateDialogOpen(true)}
      />

      {/* Main scrollable area */}
      <div className="flex-1 overflow-y-auto py-12 px-12" ref={editorContainerRef} style={{ fontFamily, fontSize: `${fontSize}pt` }}>
        {!editor ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-lg">
            Loading editor...
          </div>
        ) : (
          /* PAPER WRAPPER (paperRef) */
          <div 
            ref={paperRef} 
            className="max-w-[215.9mm] mx-auto bg-white shadow-lg relative prose prose-sm sm:prose lg:prose-lg"
          >
            <EditorContent editor={editor} />
            
            {drawingMode && (
              <>
                {/* Canvas Overlay - strictly positioned over the paper */}
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 z-10 pointer-events-auto"
                  style={{ cursor: 'crosshair' }}
                />
                
                {/* Floating Action Button for Done */}
                <Button
                  onClick={handleInsertDrawing}
                  className="absolute bottom-4 right-4 z-20 shadow-lg"
                  variant="default"
                >
                  Insert Drawing
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <Dialog open={isTemplateDialogOpen} onOpenChange={setIsTemplateDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Select Template</DialogTitle></DialogHeader>
          <Select
            onValueChange={value => {
              setSelectedTemplate(value);
              setIsTemplateDialogOpen(false);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(templates).map(key => (
                <SelectItem key={key} value={key}>
                  {key.replace(/([A-Z])/g, ' $1').trim()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>
    </div>
  );
}