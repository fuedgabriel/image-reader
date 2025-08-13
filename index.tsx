import React, { useState, useEffect, useCallback, useRef } from 'react';
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
    file: File;
    fileName: string;
    status: 'queued' | 'loading' | 'done' | 'error';
    data?: ExtractedInfo;
    errorMessage?: string;
}

// --- Component for Fullscreen Image Modal ---
const ImageModal: React.FC<{ src: string, onClose: () => void }> = ({ src, onClose }) => (
    <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt="Visualização em tela cheia" className="modal-image" />
            <button onClick={onClose} className="modal-close-button" aria-label="Fechar visualização da imagem">&times;</button>
        </div>
    </div>
);


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
        productName: { type: Type.STRING, description: "O nome principal do produto/sistema." },
        refNumber: { type: Type.STRING, description: "O número de referência, geralmente rotulado como 'REF'." },
        lotNumber: { type: Type.STRING, description: "O número do lote, geralmente rotulado como 'LOT'." },
        expirationDate: { type: Type.STRING, description: "A data de validade, geralmente próxima a um símbolo de ampulheta. Formate como AAAA-MM-DD, se possível." },
    },
    required: ["productName", "refNumber", "lotNumber", "expirationDate"],
};

const MAX_CONCURRENT_UPLOADS = 2;
const PAUSE_AFTER_REQUESTS = 8;
const PAUSE_DURATION_SECONDS = 70; // 1 minuto e 10 segundos

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
    const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
    const [isPaused, setIsPaused] = useState(false);
    const [pauseCountdown, setPauseCountdown] = useState(0);
    const requestCountRef = useRef(0);

    const extractTextFromImage = async (itemToProcess: ResultItem) => {
        try {
            const { file, id } = itemToProcess;
            const base64Data = await fileToBase64(file);
            const promptText = "Extraia as informações principais desta imagem de uma caixa de suprimentos de laboratório. Se um valor não for encontrado, retorne nulo.";
            const response = await ai.models.generateContent({
                model: model,
                contents: [{
                    parts: [
                        { text: promptText },
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

            const currentCount = requestCountRef.current + 1;
            requestCountRef.current = currentCount;

            if (currentCount > 0 && currentCount % PAUSE_AFTER_REQUESTS === 0) {
                setIsPaused(true);
                setPauseCountdown(PAUSE_DURATION_SECONDS);
            }

        } catch (error) {
            console.error("Error extracting text:", error);
            const errorMessage = (error instanceof Error) ? error.message : 'Ocorreu um erro desconhecido.';
            setResults(prev => prev.map(r => r.id === itemToProcess.id ? { ...r, status: 'error', errorMessage } : r));
        }
    };

    useEffect(() => {
        if (!isPaused || pauseCountdown <= 0) {
            if (isPaused) setIsPaused(false);
            return;
        }

        const timerId = setTimeout(() => {
            setPauseCountdown(prev => prev - 1);
        }, 1000);

        return () => clearTimeout(timerId);
    }, [isPaused, pauseCountdown]);
    
    useEffect(() => {
        if (isPaused) return;

        const currentlyLoading = results.filter(r => r.status === 'loading').length;
        const queuedItems = results.filter(r => r.status === 'queued');

        if (currentlyLoading < MAX_CONCURRENT_UPLOADS && queuedItems.length > 0) {
            const itemsToProcess = queuedItems.slice(0, MAX_CONCURRENT_UPLOADS - currentlyLoading);
            
            setResults(prev => prev.map(r => {
                if (itemsToProcess.some(item => item.id === r.id)) {
                    return { ...r, status: 'loading' };
                }
                return r;
            }));

            itemsToProcess.forEach(extractTextFromImage);
        }
        
        const isStillProcessing = results.some(r => r.status === 'loading' || r.status === 'queued');
        if (!isStillProcessing && isProcessing) {
            setIsProcessing(false);
        }

    }, [results, isPaused]);


    const handleFileSelect = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        
        setIsProcessing(true);
        const newItems: ResultItem[] = Array.from(files).map(file => ({
            id: self.crypto.randomUUID(),
            imageSrc: URL.createObjectURL(file),
            fileName: file.name,
            file,
            status: 'queued',
        }));

        setResults(prev => [...prev, ...newItems]);
    };

    const handleExportToExcel = () => {
        const dataToExport = results
            .filter(r => r.status === 'done' && r.data)
            .map(r => ({
                'Nome do Arquivo': r.fileName,
                'Nome do Produto': r.data!.productName,
                'Referência (REF)': r.data!.refNumber,
                'Número do Lote (LOT)': r.data!.lotNumber,
                'Data de Validade': r.data!.expirationDate,
            }));

        if (dataToExport.length === 0) {
            alert("Nenhum dado disponível para exportar.");
            return;
        }

        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Suprimentos de Laboratório");
        XLSX.writeFile(workbook, "DadosSuprimentosLab.xlsx");
    };
    
    const handleDeleteItem = (idToDelete: string) => {
        setResults(prev => prev.filter(item => item.id !== idToDelete));
    };

    const handleDragEvents = (e: React.DragEvent, isEntering: boolean) => {
        e.preventDefault();
        e.stopPropagation();
        if (isProcessing || isPaused) return;
        setIsDragging(isEntering);
    };

    const handleDrop = (e: React.DragEvent) => {
        handleDragEvents(e, false);
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFileSelect(files);
        }
    };
    
    const getDropZoneText = () => {
        if (isPaused) return 'Pausado...';
        if (isProcessing) return 'Processando imagens...';
        if (isDragging) return 'Arraste as imagens aqui';
        return <>Arraste e solte os arquivos ou <span>clique para procurar</span></>;
    };

    return (
        <>
            <div className="container">
                <header className="header">
                    <h1>Extrator e Exportador de Suprimentos de Laboratório</h1>
                    <p>Envie imagens de caixas de suprimentos de laboratório para extrair informações e exportar para Excel.</p>
                </header>
                
                <section className="controls">
                     <label 
                        htmlFor="file-upload" 
                        className={`drop-zone ${isDragging ? 'drag-over' : ''} ${(isProcessing || isPaused) ? 'disabled' : ''}`}
                        onDragEnter={(e) => handleDragEvents(e, true)}
                        onDragLeave={(e) => handleDragEvents(e, false)}
                        onDragOver={(e) => handleDragEvents(e, true)}
                        onDrop={handleDrop}
                    >
                        <p className="drop-zone-text">{getDropZoneText()}</p>
                        <input 
                            id="file-upload" 
                            type="file" 
                            multiple 
                            accept="image/*" 
                            className="file-input"
                            onChange={(e) => handleFileSelect(e.target.files)}
                            disabled={isProcessing || isPaused}
                        />
                    </label>
                    <button 
                        onClick={handleExportToExcel} 
                        className="btn btn-primary"
                        disabled={results.filter(r => r.status === 'done').length === 0 || isProcessing || isPaused}
                    >
                        Exportar para Excel
                    </button>
                </section>
                
                {isPaused && (
                    <div className="pause-banner">
                        <p>Limite de requisições atingido. A fila continuará em <strong>{pauseCountdown}</strong> segundos.</p>
                    </div>
                )}

                <section className="results-container">
                    {results.length > 0 ? (
                        <table className="results-table">
                            <thead>
                                <tr>
                                    <th>Imagem</th>
                                    <th>Nome do Produto</th>
                                    <th>REF #</th>
                                    <th>LOTE #</th>
                                    <th>Validade</th>
                                    <th>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map(item => (
                                    <tr key={item.id}>
                                        <td>
                                            <button className="thumbnail-button" onClick={() => setFullscreenImage(item.imageSrc)}>
                                                <img src={item.imageSrc} alt={item.fileName} className="image-thumbnail" />
                                            </button>
                                        </td>
                                        {item.status === 'queued' && <td colSpan={5}><div className="status-cell"><p className="queued-text">Na fila para processamento...</p></div></td>}
                                        {item.status === 'loading' && <td colSpan={5}><div className="status-cell"><div className="spinner"></div><p>Processando...</p></div></td>}
                                        {item.status === 'error' && (
                                            <>
                                                <td colSpan={4}><div className="status-cell error-cell"><p className="error-text">Falha na extração: {item.errorMessage}</p></div></td>
                                                <td>
                                                    <button onClick={() => handleDeleteItem(item.id)} className="btn-delete" title="Excluir item">
                                                        &#128465;
                                                    </button>
                                                </td>
                                            </>
                                        )}
                                        {item.status === 'done' && item.data && (
                                            <>
                                                <td>{item.data.productName || 'N/D'}</td>
                                                <td>{item.data.refNumber || 'N/D'}</td>
                                                <td>{item.data.lotNumber || 'N/D'}</td>
                                                <td>{item.data.expirationDate || 'N/D'}</td>
                                                <td>
                                                    <button onClick={() => handleDeleteItem(item.id)} className="btn-delete" title="Excluir item">
                                                        &#128465;
                                                    </button>
                                                </td>
                                            </>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="no-results">
                            <p>Suas imagens processadas aparecerão aqui.</p>
                        </div>
                    )}
                </section>
            </div>
            {fullscreenImage && <ImageModal src={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
        </>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);