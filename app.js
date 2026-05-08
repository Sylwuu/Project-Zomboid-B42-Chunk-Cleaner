const ui = {
    btnOpen: document.getElementById('btn-open'),
    btnReset: document.getElementById('btn-reset'),
    btnClear: document.getElementById('btn-clear'),
    btnSelectAll: document.getElementById('btn-select-all'),
    cbLoot: document.getElementById('cb-loot'),
    cbZombies: document.getElementById('cb-zombies'),
    status: document.getElementById('status-text'),
    selectedCount: document.getElementById('selected-count'),
    canvas: document.getElementById('map-canvas'),
    zoomLevel: document.getElementById('zoom-level'),
    hoverCoords: document.getElementById('hover-coords'),
};

const ctx = ui.canvas.getContext('2d', { alpha: false });

// Application State
let dirHandle = null;
let fileMap = new Map(); // "x,y" -> {x, y, map, chunkdata, zpop, files: {}}
let selectedCells = new Set();
let bounds = { minX: 0, maxX: 78, minY: 0, maxY: 63 };
let mapImageCache = new Map(); // "x,y" -> HTMLImageElement or null
let scanState = { count: 0, startTime: 0, timerInterval: null };

const mapCities = [
    { name: "West Point", x: 45, y: 27 },
    { name: "Muldraugh", x: 42, y: 39 },
    { name: "Rosewood", x: 31, y: 45 },
    { name: "March Ridge", x: 39, y: 49 },
    { name: "Irvington", x: 9, y: 55 },
    { name: "Echo Creek", x: 13, y: 42 },
    { name: "Ekron", x: 2, y: 38 },
    { name: "Brandenburg", x: 8, y: 23 },
    { name: "Riverside", x: 25, y: 20 },
    { name: "Valley Station", x: 53, y: 20 },
    { name: "Louisville", x: 50, y: 8 },
    { name: "Louisville Airport", x: 60, y: 11 }
];
let baseZoom = 1;
let camera = { x: 39, y: 31.5, zoom: 1 };
let targetCamera = { x: 39, y: 31.5, zoom: 1 };
let animFrameId = null;
let isDragging = false;
let isSelecting = false;
let dragMode = 'add'; // 'add', 'remove', 'pan'
let lastMouse = { x: 0, y: 0 };
let selectionStart = null;
let currentSelectionEnd = null;

// CSS Variables for Colors
const style = getComputedStyle(document.body);
const colors = {
    bg: style.getPropertyValue('--bg-main').trim(),
    visited: style.getPropertyValue('--map-visited').trim() || '#2ed573',
    selected: style.getPropertyValue('--map-selected').trim(),
    empty: style.getPropertyValue('--map-empty').trim() || '#2d3436',
    selectionFillAdd: 'rgba(46, 213, 115, 0.2)',
    selectionStrokeAdd: '#2ed573',
    selectionFillRemove: 'rgba(255, 71, 87, 0.2)',
    selectionStrokeRemove: '#ff4757',
};

function getBaseZoom() {
    const width = 78;
    const height = 63;
    const padding = 20;
    const zoomX = ui.canvas.width / (width + padding);
    const zoomY = ui.canvas.height / (height + padding);
    return Math.min(zoomX, zoomY) || 1;
}

function updateZoomText() {
    const pct = Math.round((camera.zoom / baseZoom) * 100);
    ui.zoomLevel.textContent = `${pct}%`;
}

function resetCamera() {
    baseZoom = getBaseZoom();
    camera.zoom = baseZoom;
    camera.x = 39;
    camera.y = 31.5;
    targetCamera.zoom = baseZoom;
    targetCamera.x = 39;
    targetCamera.y = 31.5;
    updateZoomText();
}

// Initialize Canvas Size
function resizeCanvas() {
    const parent = ui.canvas.parentElement;
    ui.canvas.width = parent.clientWidth;
    ui.canvas.height = parent.clientHeight;

    const oldBaseZoom = baseZoom;
    baseZoom = getBaseZoom();

    if (camera.zoom <= oldBaseZoom + 0.001) {
        camera.zoom = baseZoom;
        camera.x = 39;
        camera.y = 31.5;
        targetCamera.zoom = baseZoom;
        targetCamera.x = 39;
        targetCamera.y = 31.5;
    } else if (camera.zoom < baseZoom) {
        camera.zoom = baseZoom;
        targetCamera.zoom = baseZoom;
    }

    updateZoomText();
    draw();
}
window.addEventListener('resize', resizeCanvas);
ui.canvas.width = ui.canvas.parentElement.clientWidth;
ui.canvas.height = ui.canvas.parentElement.clientHeight;
resetCamera();

// ==========================================
// File System Operations
// ==========================================

async function scanDirectory(currentDirHandle, path = []) {
    let count = 0;
    const promises = [];
    for await (const entry of currentDirHandle.values()) {
        if (entry.kind === 'file') {
            scanState.count++;
            // 1. Check for isoregiondata format
            if (path.length >= 1 && path[path.length - 1] === 'isoregiondata' && entry.name.startsWith('datachunk_')) {
                const match = entry.name.match(/^datachunk_(-?\d+)_(-?\d+)\.bin$/);
                if (match) {
                    const chunkX = parseInt(match[1], 10);
                    const chunkY = parseInt(match[2], 10);
                    const x = Math.floor(chunkX / 32);
                    const y = Math.floor(chunkY / 32);
                    const key = `${x},${y}`;
                    const type = 'isoregiondata';
                    
                    if (!fileMap.has(key)) {
                        fileMap.set(key, { x, y, files: {} });
                    }
                    
                    if (!fileMap.get(key).files[type]) fileMap.get(key).files[type] = [];
                    fileMap.get(key).files[type].push({ parent: currentDirHandle, name: entry.name });
                    count++;
                    continue;
                }
            }

            // 2. Check for B42 nested format (which stores chunk coordinates): type/X/Y.bin
            if (path.length >= 2 && entry.name.endsWith('.bin')) {
                const type = path[path.length - 2];
                const xStr = path[path.length - 1];
                const yStr = entry.name.replace('.bin', '');
                
                if (!isNaN(xStr) && !isNaN(yStr) && /^-?\d+$/.test(xStr) && /^-?\d+$/.test(yStr)) {
                    const chunkX = parseInt(xStr, 10);
                    const chunkY = parseInt(yStr, 10);
                    
                    // The nested folders represent chunk coordinates.
                    // Map them to the 32x32 cell grid.
                    const x = Math.floor(chunkX / 32);
                    const y = Math.floor(chunkY / 32);
                    const key = `${x},${y}`;
                    
                    if (!fileMap.has(key)) {
                        fileMap.set(key, { x, y, files: {} });
                    }
                    
                    if (!fileMap.get(key).files[type]) fileMap.get(key).files[type] = [];
                    fileMap.get(key).files[type].push({ parent: currentDirHandle, name: entry.name });
                    count++;
                    continue;
                }
            }
            
            // 3. Check for old flat format: type_X_Y.bin
            const match = entry.name.match(/^([a-zA-Z0-9]+)_(-?\d+)_(-?\d+)\.bin$/);
            if (match) {
                const type = match[1];
                const x = parseInt(match[2], 10);
                const y = parseInt(match[3], 10);
                const key = `${x},${y}`;
                
                if (!fileMap.has(key)) {
                    fileMap.set(key, { x, y, files: {} });
                }
                
                if (!fileMap.get(key).files[type]) fileMap.get(key).files[type] = [];
                fileMap.get(key).files[type].push({ parent: currentDirHandle, name: entry.name });
                count++;
            }
        } else if (entry.kind === 'directory') {
            promises.push(scanDirectory(entry, [...path, entry.name]));
        }
    }
    
    const results = await Promise.all(promises);
    for (const res of results) {
        count += res;
    }
    
    return count;
}

ui.btnOpen.addEventListener('click', async () => {
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        ui.btnOpen.classList.remove('glow-effect');
        
        fileMap.clear();
        selectedCells.clear();
        bounds = { minX: 0, maxX: 78, minY: 0, maxY: 63 };

        scanState.count = 0;
        scanState.startTime = performance.now();
        ui.status.innerHTML = `Scanning...<br>Time: 0.0s | Files Scanned: 0`;
        
        scanState.timerInterval = setInterval(() => {
            const elapsed = ((performance.now() - scanState.startTime) / 1000).toFixed(1);
            ui.status.innerHTML = `Scanning...<br>Time: ${elapsed}s | Files Scanned: ${scanState.count}`;
        }, 100);

        const fileCount = await scanDirectory(dirHandle);
        
        clearInterval(scanState.timerInterval);
        const totalTime = ((performance.now() - scanState.startTime) / 1000).toFixed(1);

        if (fileMap.size === 0) {
            ui.status.innerHTML = `No PZ map files found. Did you select the specific save folder?<br>Took ${totalTime}s.`;
            dirHandle = null;
        } else {
            ui.status.innerHTML = `Loaded ${fileMap.size} cells (${fileCount} valid files)<br>Scan completed in ${totalTime}s.`;
            resetCamera();
            updateUI();
            draw();
        }

    } catch (err) {
        if (scanState.timerInterval) clearInterval(scanState.timerInterval);
        if (err.name !== 'AbortError') {
            console.error(err);
            ui.status.textContent = 'Error accessing folder.';
        } else {
            ui.status.textContent = 'Folder selection cancelled.';
        }
    }
});

function getMapTile(L, tx, ty) {
    const key = `${L},${tx},${ty}`;
    if (mapImageCache.has(key)) {
        return mapImageCache.get(key);
    }
    
    // Mark as loading to prevent duplicate requests
    mapImageCache.set(key, null);
    
    const img = new Image();
    img.onload = () => {
        mapImageCache.set(key, img);
        draw(); // Redraw to show the newly loaded image
    };
    img.onerror = () => {
        // Leave as null if it doesn't exist
    };
    img.src = `map_scale_${L}/${tx}_${ty}.webp`;
    
    return null;
}

ui.btnReset.addEventListener('click', async () => {
    if (!dirHandle || selectedCells.size === 0) return;

    const resetLoot = ui.cbLoot.checked;
    const resetZombies = ui.cbZombies.checked;

    if (!resetLoot && !resetZombies) {
        alert("Please select at least one type to reset (Loot or Zombies).");
        return;
    }

    if (!confirm(`Are you sure you want to PERMANENTLY delete files for ${selectedCells.size} chunks? Make sure your game/server is CLOSED.`)) {
        return;
    }

    ui.status.textContent = 'Deleting files...';
    let deletedFiles = 0;

    for (const key of selectedCells) {
        const data = fileMap.get(key);
        if (!data) continue;

        try {
            for (const [type, fileArray] of Object.entries(data.files)) {
                let shouldDelete = false;
                
                if (resetLoot && type !== 'zpop') {
                    shouldDelete = true;
                }
                if (resetZombies && type === 'zpop') {
                    shouldDelete = true;
                }
                
                if (shouldDelete) {
                    for (const fileInfo of fileArray) {
                        try {
                            await fileInfo.parent.removeEntry(fileInfo.name);
                            deletedFiles++;
                        } catch (e) {
                            console.error(`Failed to delete ${fileInfo.name}`, e);
                        }
                    }
                    delete data.files[type];
                }
            }
            
            if (Object.keys(data.files).length === 0) {
                fileMap.delete(key);
            }
        } catch (err) {
            console.error(`Failed to delete files for ${key}`, err);
        }
    }

    ui.status.textContent = `Successfully deleted ${deletedFiles} files.`;
    selectedCells.clear();
    updateUI();
    draw();
});

// ==========================================
// User Interface Actions
// ==========================================

function updateUI() {
    ui.selectedCount.textContent = selectedCells.size;
    ui.btnReset.disabled = selectedCells.size === 0;
}

ui.btnClear.addEventListener('click', () => {
    selectedCells.clear();
    updateUI();
    draw();
});

ui.btnSelectAll.addEventListener('click', () => {
    for (const key of fileMap.keys()) {
        selectedCells.add(key);
    }
    updateUI();
    draw();
});

// Update UI if toggles change to warn user if nothing selected
ui.cbLoot.addEventListener('change', checkToggles);
ui.cbZombies.addEventListener('change', checkToggles);

function checkToggles() {
    if (!ui.cbLoot.checked && !ui.cbZombies.checked) {
        ui.btnReset.disabled = true;
    } else {
        updateUI();
    }
}

// ==========================================
// Canvas Rendering & Camera
// ==========================================

function screenToWorld(screenX, screenY) {
    const x = (screenX - ui.canvas.width / 2) / camera.zoom + camera.x;
    const y = (screenY - ui.canvas.height / 2) / camera.zoom + camera.y;
    return { x, y };
}

function draw() {
    // Clear background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);

    ctx.save();
    ctx.translate(ui.canvas.width / 2, ui.canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Calculate visible area to optimize rendering
    const viewMinX = camera.x - (ui.canvas.width / 2) / camera.zoom;
    const viewMaxX = camera.x + (ui.canvas.width / 2) / camera.zoom;
    const viewMinY = camera.y - (ui.canvas.height / 2) / camera.zoom;
    const viewMaxY = camera.y + (ui.canvas.height / 2) / camera.zoom;

    // Draw 78x63 unvisited grid
    ctx.fillStyle = colors.empty;
    ctx.fillRect(0, 0, 78, 63);

    // Draw chunks
    for (const [key, data] of fileMap.entries()) {
        // Frustum culling
        if (data.x < viewMinX - 1 || data.x > viewMaxX + 1 ||
            data.y < viewMinY - 1 || data.y > viewMaxY + 1) {
            continue;
        }

        if (selectedCells.has(key)) {
            ctx.fillStyle = colors.selected;
        } else {
            ctx.fillStyle = colors.visited;
        }

        ctx.fillRect(data.x, data.y, 1, 1);
    }

    // Draw Auto-loading Overlays with LOD
    ctx.globalAlpha = 0.8;
    
    // Determine LOD Level (9 to 15)
    // We want S * camera.zoom to be roughly 256 pixels
    let L = Math.round(15 - Math.log2(256 / camera.zoom));
    L = Math.max(9, Math.min(15, L));
    
    const S = Math.pow(2, 15 - L); // S cells per tile side

    const tileStartX = Math.floor(viewMinX / S);
    const tileEndX = Math.floor(viewMaxX / S);
    const tileStartY = Math.floor(viewMinY / S);
    const tileEndY = Math.floor(viewMaxY / S);

    for (let tx = tileStartX; tx <= tileEndX; tx++) {
        for (let ty = tileStartY; ty <= tileEndY; ty++) {
            // Only draw if the tile overlaps our 78x63 map grid
            if (tx * S > 78 || tx * S + S < 0 || ty * S > 63 || ty * S + S < 0) continue;

            const img = getMapTile(L, tx, ty);
            if (img) {
                // Draw image scaled up to cover S x S cells
                // Add a tiny overlap to prevent subpixel seams on some browsers
                ctx.drawImage(img, tx * S, ty * S, S + 0.02, S + 0.02);
            }
        }
    }
    ctx.globalAlpha = 1.0;

    // Draw Selection Box
    if (isSelecting && selectionStart && currentSelectionEnd) {
        const minX = Math.min(selectionStart.x, currentSelectionEnd.x);
        const maxX = Math.max(selectionStart.x, currentSelectionEnd.x);
        const minY = Math.min(selectionStart.y, currentSelectionEnd.y);
        const maxY = Math.max(selectionStart.y, currentSelectionEnd.y);

        ctx.fillStyle = dragMode === 'add' ? colors.selectionFillAdd : colors.selectionFillRemove;
        ctx.strokeStyle = dragMode === 'add' ? colors.selectionStrokeAdd : colors.selectionStrokeRemove;
        ctx.lineWidth = 1 / camera.zoom;

        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    }

    // Draw Grid and Coordinates if zoomed in
    if (camera.zoom > 10) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1 / camera.zoom;

        const startX = Math.max(0, Math.floor(viewMinX));
        const endX = Math.min(78, Math.ceil(viewMaxX));
        const startY = Math.max(0, Math.floor(viewMinY));
        const endY = Math.min(63, Math.ceil(viewMaxY));

        ctx.beginPath();
        for (let x = startX; x <= endX; x++) {
            ctx.moveTo(x, Math.max(0, viewMinY));
            ctx.lineTo(x, Math.min(63, viewMaxY));
        }
        for (let y = startY; y <= endY; y++) {
            ctx.moveTo(Math.max(0, viewMinX), y);
            ctx.lineTo(Math.min(78, viewMaxX), y);
        }
        ctx.stroke();

        // Draw coordinates
        if (camera.zoom / baseZoom > 7) {
            ctx.fillStyle = 'rgba(255, 235, 59, 0.7)'; // Yellowish tint
            
            // Cap the text scaling divisor at 3000% zoom
            // This makes the text 15px on screen up to 3000%, and larger after.
            const textDivisor = Math.min(camera.zoom, baseZoom * 30);
            ctx.font = `${15 / textDivisor}px Outfit`; 
            
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            const offset = 4 / textDivisor; // 4px padding on screen
            
            for (let x = startX; x < endX; x++) {
                for (let y = startY; y < endY; y++) {
                    ctx.fillText(`${x},${y}`, x + offset, y + offset);
                }
            }
        }
    }

    // Draw City Names
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'; // White, highly visible
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Make city names scale up after a certain zoom, but stay a readable size beforehand
    const cityDivisor = Math.min(camera.zoom, baseZoom * 15);
    ctx.font = `800 ${18 / cityDivisor}px Outfit`;
    
    // Add a dark stroke for contrast against map textures
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 3 / cityDivisor;
    
    for (const city of mapCities) {
        // Only draw if within current view bounds
        if (city.x >= viewMinX - 2 && city.x <= viewMaxX + 2 &&
            city.y >= viewMinY - 2 && city.y <= viewMaxY + 2) {
            ctx.strokeText(city.name, city.x + 0.5, city.y + 0.5);
            ctx.fillText(city.name, city.x + 0.5, city.y + 0.5);
        }
    }

    ctx.restore();
}

// ==========================================
// Mouse Interactions
// ==========================================

function startAnimation() {
    if (animFrameId) return;

    function step() {
        const smooth = 0.25; // Interpolation speed
        
        // Stop animating if we're extremely close to the target
        if (Math.abs(targetCamera.zoom - camera.zoom) < 0.001 &&
            Math.abs(targetCamera.x - camera.x) < 0.001 &&
            Math.abs(targetCamera.y - camera.y) < 0.001) {
            
            camera.zoom = targetCamera.zoom;
            camera.x = targetCamera.x;
            camera.y = targetCamera.y;
            
            updateZoomText();
            draw();
            animFrameId = null;
            return;
        }

        camera.zoom += (targetCamera.zoom - camera.zoom) * smooth;
        camera.x += (targetCamera.x - camera.x) * smooth;
        camera.y += (targetCamera.y - camera.y) * smooth;

        updateZoomText();
        draw();
        
        animFrameId = requestAnimationFrame(step);
    }
    
    animFrameId = requestAnimationFrame(step);
}

ui.canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); // prevent page scroll
    
    // Calculate a smooth zoom factor based on scroll delta
    // A standard mouse wheel tick is usually around 100.
    // We use a base factor of 1.10 per 100 delta for smooth, controllable zoom.
    const zoomFactor = Math.pow(1.10, -e.deltaY / 100);

    // Calculate world position of mouse relative to TARGET camera
    // This allows cumulative scrolling during an ongoing animation
    const mouseWorldBefore = {
        x: (e.offsetX - ui.canvas.width / 2) / targetCamera.zoom + targetCamera.x,
        y: (e.offsetY - ui.canvas.height / 2) / targetCamera.zoom + targetCamera.y
    };

    targetCamera.zoom *= zoomFactor;
    targetCamera.zoom = Math.max(baseZoom, Math.min(targetCamera.zoom, baseZoom * 100));

    const mouseWorldAfter = {
        x: (e.offsetX - ui.canvas.width / 2) / targetCamera.zoom + targetCamera.x,
        y: (e.offsetY - ui.canvas.height / 2) / targetCamera.zoom + targetCamera.y
    };

    // Adjust target camera position so mouse stays over same world point
    targetCamera.x += mouseWorldBefore.x - mouseWorldAfter.x;
    targetCamera.y += mouseWorldBefore.y - mouseWorldAfter.y;

    startAnimation();
}, { passive: false });

ui.canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        // Pan
        isDragging = true;
        dragMode = 'pan';
        ui.canvas.style.cursor = 'grabbing';
    } else if (e.button === 0) {
        // Select (Add)
        isSelecting = true;
        dragMode = 'add';
        selectionStart = screenToWorld(e.offsetX, e.offsetY);
        currentSelectionEnd = selectionStart;
    } else if (e.button === 2) {
        // Select (Remove)
        isSelecting = true;
        dragMode = 'remove';
        selectionStart = screenToWorld(e.offsetX, e.offsetY);
        currentSelectionEnd = selectionStart;
    }
    lastMouse = { x: e.offsetX, y: e.offsetY };
});

ui.canvas.addEventListener('contextmenu', e => e.preventDefault());

ui.canvas.addEventListener('mousemove', (e) => {
    const worldPos = screenToWorld(e.offsetX, e.offsetY);
    ui.hoverCoords.textContent = `${Math.floor(worldPos.x)}, ${Math.floor(worldPos.y)}`;

    if (isDragging) {
        const dx = e.offsetX - lastMouse.x;
        const dy = e.offsetY - lastMouse.y;
        
        const worldDx = dx / camera.zoom;
        const worldDy = dy / camera.zoom;
        
        camera.x -= worldDx;
        camera.y -= worldDy;
        
        targetCamera.x -= worldDx;
        targetCamera.y -= worldDy;
        
        draw();
    }

    if (isSelecting) {
        currentSelectionEnd = worldPos;
        draw();
    }

    lastMouse = { x: e.offsetX, y: e.offsetY };
});

window.addEventListener('mouseup', (e) => {
    if (isSelecting && selectionStart && currentSelectionEnd) {
        const minX = Math.min(selectionStart.x, currentSelectionEnd.x);
        const maxX = Math.max(selectionStart.x, currentSelectionEnd.x);
        const minY = Math.min(selectionStart.y, currentSelectionEnd.y);
        const maxY = Math.max(selectionStart.y, currentSelectionEnd.y);

        let changed = false;

        // Handle Box Selection
        if (Math.abs(minX - maxX) > 0.1 || Math.abs(minY - maxY) > 0.1) {
            for (const [key, data] of fileMap.entries()) {
                // Check if the chunk is fully within the selection bounds
                if (data.x >= minX && data.x + 1 <= maxX &&
                    data.y >= minY && data.y + 1 <= maxY) {
                    if (dragMode === 'add') {
                        selectedCells.add(key);
                    } else if (dragMode === 'remove') {
                        selectedCells.delete(key);
                    }
                    changed = true;
                }
            }
        } else {
            // Handle Single Click (point selection)
            const cx = Math.floor(minX);
            const cy = Math.floor(minY);
            const key = `${cx},${cy}`;

            if (fileMap.has(key)) {
                if (dragMode === 'add') {
                    if (selectedCells.has(key)) {
                        selectedCells.delete(key); // toggle
                    } else {
                        selectedCells.add(key);
                    }
                } else {
                    selectedCells.delete(key);
                }
                changed = true;
            }
        }

        if (changed) {
            updateUI();
        }
    }

    isDragging = false;
    isSelecting = false;
    selectionStart = null;
    currentSelectionEnd = null;
    ui.canvas.style.cursor = 'crosshair';

    draw();
});

// Initial draw
draw();
