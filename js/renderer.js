class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Camera parameters
        this.cameraHeight = 1000;
        this.cameraDepth = 1 / Math.tan((100 / 2) * Math.PI / 180); // FOV ~ 100 degrees
        this.drawDistance = 300;

        // Road rendering parameters
        this.roadWidth = 2000;
        this.lanes = 3;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.width = this.canvas.width;
        this.height = this.canvas.height;
    }

    clear() {
        this.ctx.fillStyle = '#87CEEB'; // Sky color
        this.ctx.fillRect(0, 0, this.width, this.height);
    }

    project(p, cameraX, cameraY, cameraZ) {
        p.camera.x = (p.world.x || 0) - cameraX;
        p.camera.y = (p.world.y || 0) - cameraY;
        p.camera.z = (p.world.z || 0) - cameraZ;

        p.screen.scale = this.cameraDepth / p.camera.z;
        p.screen.x = Math.round((this.width / 2) + (p.screen.scale * p.camera.x * this.width / 2));
        p.screen.y = Math.round((this.height / 2) - (p.screen.scale * p.camera.y * this.height / 2));
        p.screen.w = Math.round((p.screen.scale * this.roadWidth * this.width / 2));
    }

    drawPolygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.lineTo(x3, y3);
        this.ctx.lineTo(x4, y4);
        this.ctx.closePath();
        this.ctx.fill();
    }

    drawSegment(segment, theme) {
        const x1 = segment.p1.screen.x;
        const y1 = segment.p1.screen.y;
        const w1 = segment.p1.screen.w;

        const x2 = segment.p2.screen.x;
        const y2 = segment.p2.screen.y;
        const w2 = segment.p2.screen.w;

        // Draw grass (background) or cliffs
        if (theme === 'Mountain') {
            // Left side: Cliffside barrier
            this.drawPolygon(
                0, y1,
                x1 - w1, y1,
                x2 - w2, y2,
                0, y2,
                '#4a3c31' // Dark brownish cliff
            );

            // Also draw a cliff wall vertical barrier on the left edge of the road
            const h1 = segment.p1.screen.scale * 5000;
            const h2 = segment.p2.screen.scale * 5000;
            const dw1 = segment.p1.screen.scale * 1000;
            const dw2 = segment.p2.screen.scale * 1000;
            this.drawPolygon(
                x1 - w1 - dw1, y1 - h1,
                x1 - w1, y1,
                x2 - w2, y2,
                x2 - w2 - dw2, y2 - h2,
                '#3a2c21'
            );

            // Right side: Drop-off (sky). We draw nothing so the sky shows through.
        } else {
            this.drawPolygon(
                0, y1,
                this.width, y1,
                this.width, y2,
                0, y2,
                segment.color.grass
            );
        }

        // Draw rumble strips
        const r1 = w1 / Math.max(6, 2 * this.lanes);
        const r2 = w2 / Math.max(6, 2 * this.lanes);
        this.drawPolygon(
            x1 - w1 - r1, y1,
            x1 - w1, y1,
            x2 - w2, y2,
            x2 - w2 - r2, y2,
            segment.color.rumble
        );
        this.drawPolygon(
            x1 + w1 + r1, y1,
            x1 + w1, y1,
            x2 + w2, y2,
            x2 + w2 + r2, y2,
            segment.color.rumble
        );

        // Draw road
        this.drawPolygon(
            x1 - w1, y1,
            x1 + w1, y1,
            x2 + w2, y2,
            x2 - w2, y2,
            segment.color.road
        );

        // Draw lane markers
        if (segment.color.lane) {
            const laneW1 = w1 * 2 / this.lanes;
            const laneW2 = w2 * 2 / this.lanes;
            const l1 = w1 / 32;
            const l2 = w2 / 32;

            for (let lane = 1; lane < this.lanes; lane++) {
                const laneX1 = x1 - w1 + laneW1 * lane;
                const laneX2 = x2 - w2 + laneW2 * lane;
                this.drawPolygon(
                    laneX1 - l1/2, y1,
                    laneX1 + l1/2, y1,
                    laneX2 + l2/2, y2,
                    laneX2 - l2/2, y2,
                    segment.color.lane
                );
            }
        }
    }

    drawBackground(theme, playerX, playerY) {
        if (theme === 'City') {
            // Draw pseudo-skyscrapers
            this.ctx.fillStyle = '#1a1a2e';
            this.ctx.fillRect(0, 0, this.width, this.height);

            // Draw simple grid or buildings based on view
            this.ctx.fillStyle = '#16213e';
            const offset = (playerX * 100) % 200;
            for (let i = -this.width; i < this.width * 2; i += 200) {
                this.ctx.fillRect(i - offset, this.height/2 - 300, 100, 300 + playerY * 0.1);
            }

            // Sun/Moon
            this.ctx.fillStyle = '#e94560';
            this.ctx.beginPath();
            this.ctx.arc(this.width/2 - playerX * 50, this.height/4, 100, 0, Math.PI*2);
            this.ctx.fill();

        } else {
            // Mountain
            // Draw mountain ranges
            this.ctx.fillStyle = '#a8d8ea';
            this.ctx.fillRect(0, 0, this.width, this.height);

            const offset = (playerX * 50) % 300;

            this.ctx.fillStyle = '#aa96da';
            this.ctx.beginPath();
            this.ctx.moveTo(0 - offset, this.height/2);
            this.ctx.lineTo(150 - offset, this.height/2 - 200);
            this.ctx.lineTo(300 - offset, this.height/2);
            this.ctx.fill();

            this.ctx.fillStyle = '#fcbad3';
            this.ctx.beginPath();
            this.ctx.moveTo(200 - offset, this.height/2);
            this.ctx.lineTo(400 - offset, this.height/2 - 300);
            this.ctx.lineTo(600 - offset, this.height/2);
            this.ctx.fill();
        }
    }

    render(road, player) {
        this.clear();

        // Draw background before road
        this.drawBackground(road.currentTheme, player.x, player.y);

        const baseSegment = road.getSegment(player.z);
        if (!baseSegment) return;

        const basePercent = (player.z % road.segmentLength) / road.segmentLength;
        const playerY = player.y + this.cameraHeight;

        let maxy = this.height;
        let x = 0;
        let dx = - (baseSegment.curve * basePercent);

        const renderSegments = [];

        // Pass 1: Project front-to-back and determine visibility
        for (let n = 0; n < this.drawDistance; n++) {
            const segment = road.getSegment(player.z + n * road.segmentLength);
            if (!segment) break;

            // Apply curve accumulation to x
            segment.p1.world.x = x;
            segment.p2.world.x = x + dx;

            x += dx;
            dx += segment.curve;

            this.project(segment.p1, (player.x * this.roadWidth) - x, playerY, player.z - (n === 0 ? 0 : this.cameraDepth));
            this.project(segment.p2, (player.x * this.roadWidth) - x - dx, playerY, player.z);

            segment.clip = maxy;

            if (segment.p1.camera.z <= this.cameraDepth) {
                continue;
            }

            renderSegments.push(segment);
            maxy = Math.min(maxy, segment.p1.screen.y);
        }

        // Pass 2: Draw back-to-front (Painter's Algorithm)
        for (let n = renderSegments.length - 1; n >= 0; n--) {
            const segment = renderSegments[n];

            // Backface culling: don't draw downhill segments facing away
            if (segment.p2.screen.y >= segment.p1.screen.y) {
                continue;
            }

            // Don't draw if it's fully clipped by a hill in front of it
            if (segment.p1.screen.y >= segment.clip && segment.p2.screen.y >= segment.clip) {
                continue;
            }

            this.drawSegment(segment, road.currentTheme);
        }

        // Render Player (Simple car rectangle)
        this.renderPlayer(player);
    }

    renderPlayer(player) {
        // Since it's a minimal racing game, we represent the car as a styled block or polygon
        const carWidth = 100;
        const carHeight = 50;
        const x = this.width / 2;
        const y = this.height - 100; // Bottom of the screen

        // Shadow
        this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
        this.ctx.fillRect(x - carWidth/2, y, carWidth, 20);

        // Car Body
        this.ctx.fillStyle = '#ff3366';
        this.ctx.fillRect(x - carWidth/2, y - carHeight, carWidth, carHeight);

        // Windshield
        this.ctx.fillStyle = '#111';
        this.ctx.fillRect(x - carWidth/2 + 10, y - carHeight + 5, carWidth - 20, 20);

        // Tires
        this.ctx.fillStyle = '#222';
        this.ctx.fillRect(x - carWidth/2 - 10, y - 15, 20, 30); // left rear
        this.ctx.fillRect(x + carWidth/2 - 10, y - 15, 20, 30); // right rear
    }
}
