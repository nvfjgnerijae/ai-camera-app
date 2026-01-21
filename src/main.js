import 'cropperjs/dist/cropper.css';
import Cropper from 'cropperjs';
import './style.css'; // Ensure CSS is loaded

// Elements
const cameraView = document.getElementById('camera-view');
const editorView = document.getElementById('editor-view');
const video = document.getElementById('camera-feed');
const canvas = document.createElement('canvas'); // Offscreen for capture
const captureImage = document.getElementById('capture-image');
const drawingCanvas = document.getElementById('drawing-canvas');
const ctx = drawingCanvas.getContext('2d');
const toast = document.getElementById('toast');

// Buttons
const btnShutter = document.getElementById('btn-shutter');
const btnSwitchCamera = document.getElementById('btn-switch-camera');
const btnRetake = document.getElementById('btn-retake');
const btnModeCrop = document.getElementById('btn-mode-crop');
const btnModeDraw = document.getElementById('btn-mode-draw');
const btnUndo = document.getElementById('btn-undo'); // New
const btnRedo = document.getElementById('btn-redo'); // New
const btnCopy = document.getElementById('btn-copy');
const btnSave = document.getElementById('btn-save'); // New
const colorBtns = document.querySelectorAll('.color-btn');
const drawColors = document.getElementById('draw-colors');

// State
let stream = null;
let currentFacingMode = 'environment';
let cropper = null;
let originalImageSrc = ''; // To restore if needed (though we might do destructive crop for simplicity)
let mode = 'crop'; // 'crop' | 'draw'
let isDrawing = false;
let lastX = 0;
let lastY = 0;

let drawColor = '#ff3b30'; // Default red

// Undo/Redo State
let historyStack = [];
let historyStep = -1;
const MAX_HISTORY = 10;

// Zoom State
let videoTrack = null;
let zoomCapabilities = { min: 1, max: 1, step: 0.1 };
let currentZoom = 1;
let initialPinchDistance = 0;
let initialZoomAtPinch = 1;

// --- Camera Functions ---

async function initCamera() {
  try {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    const constraints = {
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;

    // Get Video Track & Capabilities for Zoom
    videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const capabilities = videoTrack.getCapabilities(); // Might need polyfill check or ensure support
      if (capabilities && capabilities.zoom) {
        zoomCapabilities = {
          min: capabilities.zoom.min,
          max: capabilities.zoom.max,
          step: capabilities.zoom.step
        };
        currentZoom = zoomCapabilities.min;
      }
    }

    await video.play();
  } catch (err) {
    console.error('Camera init error:', err);
    alert('カメラを起動できませんでした。権限を確認してください。');
  }
}

function switchCamera() {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  initCamera();
}

function takePicture() {
  // Flash effect
  const flash = document.getElementById('flash-overlay');
  flash.classList.add('trigger');
  setTimeout(() => flash.classList.remove('trigger'), 200);

  // Set canvas size to video size
  const width = video.videoWidth;
  const height = video.videoHeight;
  canvas.width = width;
  canvas.height = height;

  // Draw video frame
  const context = canvas.getContext('2d');
  // Flip if using front camera for mirror effect? Usually better to keep it true to reality for rear, mirror for front.
  // For simplicity, just draw.
  if (currentFacingMode === 'user') {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);

  // Export to blob/url
  const dataUrl = canvas.toDataURL('image/png');
  originalImageSrc = dataUrl;

  showEditor(dataUrl);
}

// --- Editor Functions ---

function showEditor(src) {
  // Capture view -> Editor view
  captureImage.src = src;

  cameraView.classList.remove('active');
  cameraView.classList.add('hidden');
  editorView.classList.remove('hidden');
  editorView.classList.add('active');

  // Wait for image load to init cropper
  captureImage.onload = () => {
    // Default to crop mode
    setMode('crop');
  };
}

function hideEditor() {
  // Destroy cropper
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  // Clear styles/src
  captureImage.src = '';
  // Reset canvas
  ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);

  editorView.classList.remove('active');
  editorView.classList.add('hidden');
  cameraView.classList.remove('hidden');
  cameraView.classList.add('active');
}

function setMode(newMode) {
  mode = newMode;

  // UI Updates
  if (mode === 'crop') {
    btnModeCrop.classList.add('active');
    btnModeDraw.classList.remove('active');
    drawColors.classList.add('hidden');
    editorView.classList.remove('drawing-mode');

    // Init Cropper
    if (!cropper) {
      cropper = new Cropper(captureImage, {
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 1, // Start max
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
      });
    }

    // Hide drawing canvas while cropping (or better: clear it if we are resetting?)
    // If we switch back to crop, we might lose drawings if we don't merge them.
    // For this "One Way" flow:
    // Transition Draw -> Crop: Warn or just reset?
    // Let's decided: "Draw" is an overlay. If you crop, the overlay stays relative to the screen? No.
    // If you crop AFTER drawing, the drawing position is invalid.
    // RULE: Switching to Crop Mode clears drawings. Or we stick to "Crop then Draw".
    // Let's implement: "Crop Mode" is the base state. "Draw Mode" applies the crop and lets you draw.
  } else if (mode === 'draw') {
    // Switching FROM Crop TO Draw
    btnModeDraw.classList.add('active');
    btnModeCrop.classList.remove('active');
    drawColors.classList.remove('hidden');
    editorView.classList.add('drawing-mode');

    if (cropper) {
      // Apply Crop!
      const croppedCanvas = cropper.getCroppedCanvas();
      const croppedDataUrl = croppedCanvas.toDataURL('image/png');

      cropper.destroy();
      cropper = null;

      captureImage.src = croppedDataUrl;

      // Adjust Drawing Canvas Size to match new Image Size
      // Need to wait for image to update?
      captureImage.onload = () => {
        resizeCanvasToImage();
      };
      // In case onload doesn't fire if src is same (unlikely), force check?
      // Since we changed src, it should fire.
    } else {
      // Already in draw mode (or no cropper), just ensure sizing
      resizeCanvasToImage();
    }
    // Initialize History for new drawing session
    historyStack = [];
    historyStep = -1;
    saveHistory();
    updateUndoRedoButtons();
  }
}

function resizeCanvasToImage() {
  const rect = captureImage.getBoundingClientRect();
  drawingCanvas.width = rect.width;
  drawingCanvas.height = rect.height;
  drawingCanvas.style.width = `${rect.width}px`;
  drawingCanvas.style.height = `${rect.height}px`;
  drawingCanvas.style.top = `${captureImage.offsetTop}px`;
  drawingCanvas.style.left = `${captureImage.offsetLeft}px`;

  // Set context properties
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = drawColor;
}

// --- Zoom Logic ---

function handlePinchStart(e) {
  if (e.touches.length === 2) {
    initialPinchDistance = getPinchDistance(e);
    initialZoomAtPinch = currentZoom;
  }
}

function handlePinchMove(e) {
  if (e.touches.length === 2) {
    e.preventDefault(); // Prevent browser zoom/scroll

    if (zoomCapabilities.max <= zoomCapabilities.min) return; // No zoom support

    const currentDistance = getPinchDistance(e);
    if (initialPinchDistance === 0) return;

    const scale = currentDistance / initialPinchDistance;
    let newZoom = initialZoomAtPinch * scale;

    // Clamp
    newZoom = Math.max(zoomCapabilities.min, Math.min(newZoom, zoomCapabilities.max));

    if (Math.abs(newZoom - currentZoom) > 0.05) { // Threshold
      applyZoom(newZoom);
    }
  }
}

function getPinchDistance(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function applyZoom(zoom) {
  if (!videoTrack) return;
  try {
    videoTrack.applyConstraints({ advanced: [{ zoom: zoom }] });
    currentZoom = zoom;
  } catch (err) {
    console.error('Zoom apply failed', err);
  }
}


// --- Drawing Logic ---

function startDrawing(e) {
  if (mode !== 'draw') return;
  isDrawing = true;
  const { x, y } = getEventPos(e);
  lastX = x;
  lastY = y;
}

function draw(e) {
  if (!isDrawing || mode !== 'draw') return;
  e.preventDefault();
  const { x, y } = getEventPos(e);

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();

  lastX = x;
  lastY = y;
}

function stopDrawing() {
  if (!isDrawing) return;
  isDrawing = false;
  saveHistory(); // Save state after stroke
}

// --- Undo/Redo Functions ---

function saveHistory() {
  // Discard future if we are in middle of stack
  if (historyStep < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyStep + 1);
  }

  // Save current state
  const imageData = ctx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height);
  historyStack.push(imageData);
  historyStep++;

  // Limit history
  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
    historyStep--;
  }

  updateUndoRedoButtons();
}

function undo() {
  if (historyStep > 0) {
    historyStep--;
    restoreHistory();
  }
}

function redo() {
  if (historyStep < historyStack.length - 1) {
    historyStep++;
    restoreHistory();
  }
}

function restoreHistory() {
  const imageData = historyStack[historyStep];
  ctx.putImageData(imageData, 0, 0);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  btnUndo.disabled = historyStep <= 0;
  btnRedo.disabled = historyStep >= historyStack.length - 1;
}

function getEventPos(e) {
  const rect = drawingCanvas.getBoundingClientRect();
  let clientX, clientY;

  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }

  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

// --- Copy & Export ---

async function copyToClipboard() {
  try {
    let finalCanvas = await generateFinalCanvas();

    try {
      // Create the ClipboardItem with a Promise that resolves to the blob
      const item = new ClipboardItem({
        'image/png': new Promise((resolve) => {
          finalCanvas.toBlob((blob) => {
            resolve(blob);
          }, 'image/png');
        })
      });

      await navigator.clipboard.write([item]);
      showToast();
      setTimeout(() => {
        hideEditor();
      }, 1500);

    } catch (err) {
      console.error('Clipboard write failed:', err);
      alert('クリップボードへの保存に失敗しました。');
    }

  } catch (err) {
    console.error('Export failed:', err);
  }
}

async function saveImage() {
  try {
    const finalCanvas = await generateFinalCanvas();

    finalCanvas.toBlob(async (blob) => {
      if (!blob) {
        alert('画像生成に失敗しました');
        return;
      }

      // Try Share API first (Mobile friendly)
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], "photo.png", { type: "image/png" });
        const shareData = {
          files: [file],
        };
        if (navigator.canShare(shareData)) {
          try {
            await navigator.share(shareData);
            return; // Success
          } catch (err) {
            if (err.name !== 'AbortError') {
              console.error('Share failed', err);
            }
            // If share fails (or user cancels), we might want to fallback or just stop. 
            // Usually if user cancels share sheet, we don't need to do anything.
            // But if share API is not really supported or fails, proceed to download.
          }
        }
      }

      // Fallback: Download Link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `photo_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    }, 'image/png');

  } catch (err) {
    console.error('Save failed:', err);
    alert('保存に失敗しました');
  }
}

// Helper to generate canvas from Crop/Draw
async function generateFinalCanvas() {
  if (mode === 'crop' && cropper) {
    return cropper.getCroppedCanvas();
  } else {
    const w = captureImage.naturalWidth;
    const h = captureImage.naturalHeight;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = w;
    finalCanvas.height = h;
    const fCtx = finalCanvas.getContext('2d');

    fCtx.drawImage(captureImage, 0, 0, w, h);

    const rect = captureImage.getBoundingClientRect();
    fCtx.drawImage(drawingCanvas, 0, 0, rect.width, rect.height, 0, 0, w, h);

    return finalCanvas;
  }
}

function showToast() {
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// --- Event Listeners ---

// Camera
// Camera
// Use pointerdown or touchstart to capture immediately to reduce shake
const handleShutter = (e) => {
  e.preventDefault(); // Prevent ghost clicks
  takePicture();
};
btnShutter.addEventListener('touchstart', handleShutter, { passive: false });
btnShutter.addEventListener('mousedown', handleShutter);
// btnShutter.addEventListener('click', takePicture); // Removed click to prevent double trigger or delay
btnSwitchCamera.addEventListener('click', switchCamera);

// Orientation Handler for Icons
// Since we lock screen to portrait, we rotate icons to match physical orientation
window.addEventListener("deviceorientation", (event) => {
  const { beta, gamma } = event;
  // beta: front-back tilt [-180, 180]
  // gamma: left-right tilt [-90, 90]

  // Basic thresholding. 
  // Portrait: beta ~ 90, gamma ~ 0
  // Landscape Left: gamma ~ -90
  // Landscape Right: gamma ~ 90
  // Upside Down: beta ~ -90

  let angle = 0;

  const absGamma = Math.abs(gamma);
  const absBeta = Math.abs(beta);

  if (absGamma > absBeta && absGamma > 45) {
    // Landscape
    if (gamma > 0) {
      angle = -90; // Rotate right
    } else {
      angle = 90; // Rotate left
    }
  } else if (beta < -45) {
    angle = 180; // Upside down
  } else {
    angle = 0; // Portrait
  }

  // Apply rotation with animation
  const icons = [btnSwitchCamera.querySelector('svg')]; // Rotate the SVG inside
  icons.forEach(icon => {
    if (icon) {
      icon.style.transition = 'transform 0.3s ease';
      icon.style.transform = `rotate(${angle}deg)`;
    }
  });
}, true);

// Zoom Pinch Listeners
cameraView.addEventListener('touchstart', handlePinchStart, { passive: false });
cameraView.addEventListener('touchmove', handlePinchMove, { passive: false });

// Editor
btnRetake.addEventListener('click', () => {
  // If we are in draw mode (meaning we already cropped), "Retake" might mean "Undo Crop"?
  // Simpler: Retake means "Take new photo".
  hideEditor();
});
btnModeCrop.addEventListener('click', () => {
  if (mode === 'draw') {
    if (confirm('変更を破棄してトリミングに戻りますか？')) {
      captureImage.src = originalImageSrc;
      setMode('crop');
      ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    }
  } else {
    setMode('crop');
  }
});

btnModeDraw.addEventListener('click', () => setMode('draw'));

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// Drawing
drawingCanvas.addEventListener('mousedown', startDrawing);
drawingCanvas.addEventListener('mousemove', draw);
drawingCanvas.addEventListener('mouseup', stopDrawing);
drawingCanvas.addEventListener('mouseout', stopDrawing);

drawingCanvas.addEventListener('touchstart', startDrawing, { passive: false });
drawingCanvas.addEventListener('touchmove', draw, { passive: false });
drawingCanvas.addEventListener('touchend', stopDrawing);

// Color Selection
colorBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    // Reset active
    colorBtns.forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    drawColor = e.target.dataset.color;
    ctx.strokeStyle = drawColor;
  });
});

// Copy
btnCopy.addEventListener('click', copyToClipboard);
btnSave.addEventListener('click', saveImage);

// Init
initCamera();

// Handle Resize
window.addEventListener('resize', () => {
  if (mode === 'draw') resizeCanvasToImage();
});
