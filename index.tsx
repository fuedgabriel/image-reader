import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Declare XLSX to inform TypeScript it's available globally from the CDN script
declare var XLSX: any;

// --- Interfaces for our data structures ---
interface ExtractedInfo {
    productName: string | null;
    refNumber: string | null;
    lotNumber: string | null;
    expirationDate: string | null;
}

interface ResultItem {
    id: string;
    imageSrc: string;
    fileName: string;
    status: 'loading' | 'done' | 'error';
    data?: ExtractedInfo;
    errorMessage?: string;
}

// --- Gemini API Configuration ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    throw new Error("API_KEY environment variable not set");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

const model = 'gemini-2.5-flash';
const extractionSchema = {
    type: Type.OBJECT,
    properties: {
        productName: { type: Type.STRING, description: "The main name of the product/system." },
        refNumber: { type: Type.STRING, description: "The reference number, often labeled 'REF'." },
        lotNumber: { type: Type.STRING, description: "The lot number, often labeled 'LOT'." },
        expirationDate: { type: Type.STRING, description: "The expiration date, often near an hourglass symbol. Format as YYYY-MM-DD if possible." },
    },
    required: ["productName", "refNumber", "lotNumber", "expirationDate"],
};


// --- Helper Functions ---
const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = error => reject(error);
    });
};


const App: React.FC = () => {
    const [results, setResults] = useState<ResultItem[]>([]);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [isDragging, setIsDragging] = useState<boolean>(false);

    const extractTextFromImage = async (file: File, id: string) => {
        try {
            const base64Data = await fileToBase64(file);
            const response = await ai.models.generateContent({
                model: model,
                contents: [{
                    parts: [
                        { text: "Extract the key information from this image of a laboratory supply box. If a value is not found, return null." },
                        { inlineData: { mimeType: file.type, data: base64Data } }
                    ]
                }],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: extractionSchema,
                },
            });
            
            const extractedData = JSON.parse(response.text) as ExtractedInfo;
            setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'done', data: extractedData } : r));

        } catch (error) {
            console.error("Error extracting text:", error);
            const errorMessage = (error instanceof Error) ? error.message : 'An unknown error occurred.';
            setResults(prev => prev.map(r => r.id === id ? { ...r, status: 'error', errorMessage } : r));
        }
    };

    const handleFileSelect = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        
        setIsProcessing(true);
        const newItems: ResultItem[] = Array.from(files).map(file => ({
            id: self.crypto.randomUUID(),
            imageSrc: URL.createObjectURL(file),
            fileName: file.name,
            status: 'loading',
        }));

        setResults(prev => [...prev, ...newItems]);
        
        await Promise.all(newItems.map(item => {
            const file = Array.from(files).find(f => f.name === item.fileName);
            if (file) {
                return extractTextFromImage(file, item.id);
            }
            return Promise.resolve();
        }));

        setIsProcessing(false);
    };

    const handleExportToExcel = () => {
        const dataToExport = results
            .filter(r => r.status === 'done' && r.data)
            .map(r => ({
                'File Name': r.fileName,
                'Product Name': r.data!.productName,
                'Reference (REF)': r.data!.refNumber,
                'Lot Number (LOT)': r.data!.lotNumber,
                'Expiration Date': r.data!.expirationDate,
            }));

        if (dataToExport.length === 0) {
            alert("No data available to export.");
            return;
        }

        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Lab Supplies");
        XLSX.writeFile(workbook, "LabSupplyData.xlsx");
    };
    
    // --- Drag and Drop Handlers ---
    const handleDragEvents = (e: React.DragEvent, isEntering: boolean) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(isEntering);
    };

    const handleDrop = (e: React.DragEvent) => {
        handleDragEvents(e, false);
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFileSelect(files);
        }
    };


    return (
        <div className="container">
            <header className="header">
                <h1>Lab Supply OCR & Exporter</h1>
                <p>Upload images of lab supply boxes to extract info and export to Excel.</p>
            </header>
            
            <section className="controls">
                 <label 
                    htmlFor="file-upload" 
                    className={`drop-zone ${isDragging ? 'drag-over' : ''}`}
                    onDragEnter={(e) => handleDragEvents(e, true)}
                    onDragLeave={(e) => handleDragEvents(e, false)}
                    onDragOver={(e) => handleDragEvents(e, true)}
                    onDrop={handleDrop}
                >
                    <p className="drop-zone-text">
                       {isDragging ? 'Drop images here' : <>Drag & drop files or <span>click to browse</span></>}
                    </p>
                    <input 
                        id="file-upload" 
                        type="file" 
                        multiple 
                        accept="image/*" 
                        className="file-input"
                        onChange={(e) => handleFileSelect(e.target.files)}
                        disabled={isProcessing}
                    />
                </label>
                <button 
                    onClick={handleExportToExcel} 
                    className="btn btn-primary"
                    disabled={results.filter(r => r.status === 'done').length === 0 || isProcessing}
                >
                    Export to Excel
                </button>
            </section>

            <section className="results-container">
                {results.length > 0 ? (
                    <table className="results-table">
                        <thead>
                            <tr>
                                <th>Image</th>
                                <th>Product Name</th>
                                <th>REF #</th>
                                <th>LOT #</th>
                                <th>Expires</th>
                            </tr>
                        </thead>
                        <tbody>
                            {results.map(item => (
                                <tr key={item.id}>
                                    <td><img src={item.imageSrc} alt={item.fileName} className="image-thumbnail" /></td>
                                    {item.status === 'loading' && <td colSpan={4}><div className="status-cell"><div className="spinner"></div></div></td>}
                                    {item.status === 'error' && <td colSpan={4}><div className="status-cell"><p className="error-text">Failed to extract: {item.errorMessage}</p></div></td>}
                                    {item.status === 'done' && item.data && (
                                        <>
                                            <td>{item.data.productName || 'N/A'}</td>
                                            <td>{item.data.refNumber || 'N/A'}</td>
                                            <td>{item.data.lotNumber || 'N/A'}</td>
                                            <td>{item.data.expirationDate || 'N/A'}</td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="no-results">
                        <p>Your processed images will appear here.</p>
                    </div>
                )}
            </section>
        </div>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
