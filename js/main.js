const canvas = document.getElementById('gameCanvas');
const hudSpeed = document.getElementById('hud-speed');
const hudScore = document.getElementById('hud-score');
const hudMode = document.getElementById('hud-mode');

let lastTime = 0;
let isPlaying = false;
let dt = 0;
const step = 1 / 60;

const road = new Road();
const player = new Player();
const renderer = new Renderer(canvas);

let animationFrameId;

function updateHUD() {
    // Convert generic speed units to a fake MPH
    const mph = Math.round(player.speed / player.maxSpeed * 200);
    hudSpeed.innerText = mph;

    // Convert z position to score (distance)
    hudScore.innerText = Math.floor(player.z / 100);
    hudMode.innerText = road.currentTheme;
}

function gameLoop(time) {
    if (!isPlaying) return;

    if (!lastTime) {
        lastTime = time;
    }

    dt = Math.min(1, (time - lastTime) / 1000);
    lastTime = time;

    // Logic update
    player.update(dt, road);
    road.update(player.z);

    // Render update
    renderer.render(road, player);

    // HUD update
    updateHUD();

    animationFrameId = requestAnimationFrame(gameLoop);
}

function startGame(theme) {
    cancelAnimationFrame(animationFrameId);

    player.reset();
    road.reset(theme);

    isPlaying = true;
    lastTime = performance.now();

    requestAnimationFrame(gameLoop);
}

// Initialize Menu
const menu = new Menu(startGame);

// Initial state: show menu, render an empty/initial road behind it just for looks
road.reset('City');
renderer.render(road, player);
menu.showMenu();
