// Core parameters for road generation
const SEGMENT_LENGTH = 200;
const RUMBLE_LENGTH = 3;

class Road {
    constructor() {
        this.segments = [];
        this.segmentLength = SEGMENT_LENGTH;
        this.trackLength = 0;
        this.visibleSegments = 300;

        // Procedural generation state
        this.currentTheme = 'City'; // 'City' or 'Mountain'
        this.lastGeneratedIndex = -1;
        this.generationOffset = 0;
    }

    reset(theme) {
        this.segments = [];
        this.trackLength = 0;
        this.currentTheme = theme;
        this.lastGeneratedIndex = -1;
        this.generationOffset = 0;

        // Generate initial chunks so there's track to drive on right away
        this.generateChunk(0);
        this.generateChunk(1);
    }

    getSegment(position) {
        const index = Math.floor(position / this.segmentLength);
        if (index >= 0 && index < this.segments.length) {
            return this.segments[index];
        }
        // If we reach the end or off track, return the last valid or a default segment
        if (this.segments.length > 0 && index >= this.segments.length) {
            return this.segments[this.segments.length - 1];
        }
        return null;
    }

    addSegment(curve, y) {
        const n = this.segments.length;
        this.segments.push({
            index: n,
            p1: { world: { y: this.lastY(), z:  n   * this.segmentLength }, camera: {}, screen: {} },
            p2: { world: { y: y,       z: (n+1) * this.segmentLength }, camera: {}, screen: {} },
            curve: curve,
            color: Math.floor(n / RUMBLE_LENGTH) % 2 ? this.getColors().dark : this.getColors().light,
            clip: 0
        });
        this.trackLength = this.segments.length * this.segmentLength;
    }

    lastY() {
        return (this.segments.length === 0) ? 0 : this.segments[this.segments.length-1].p2.world.y;
    }

    getColors() {
        if (this.currentTheme === 'City') {
            return {
                light: { road: '#666', grass: '#222', rumble: '#555', lane: '#CCC' },
                dark:  { road: '#555', grass: '#333', rumble: '#BB0000', lane: '#555' }
            };
        } else {
            // Mountain
            return {
                light: { road: '#444', grass: '#482', rumble: '#fff', lane: '#CCC' },
                dark:  { road: '#444', grass: '#371', rumble: '#BB0000', lane: '#444' }
            };
        }
    }

    addRoad(enter, hold, leave, curve, y) {
        const startY = this.lastY();
        const endY = startY + (Math.floor(y) || 0);

        const total = enter + hold + leave;
        let currentY;

        for (let n = 0; n < enter; n++) {
            currentY = this.easeInOut(startY, endY, n / total);
            this.addSegment(this.easeIn(0, curve, n / enter), currentY);
        }

        for (let n = 0; n < hold; n++) {
            currentY = this.easeInOut(startY, endY, (enter + n) / total);
            this.addSegment(curve, currentY);
        }

        for (let n = 0; n < leave; n++) {
            currentY = this.easeInOut(startY, endY, (enter + hold + n) / total);
            this.addSegment(this.easeInOut(curve, 0, n / leave), currentY);
        }
    }

    addStraight(num) {
        num = num || 50;
        this.addRoad(num, num, num, 0, 0);
    }

    addCurve(num, curve, height) {
        num = num || 50;
        curve = curve || 1;
        height = height || 0;
        this.addRoad(num, num, num, curve, height);
    }

    addHill(num, height) {
        num = num || 50;
        height = height || 0;
        this.addRoad(num, num, num, 0, height);
    }

    easeInOut(a, b, percent) {
        return a + (b - a) * ((-Math.cos(percent * Math.PI) / 2) + 0.5);
    }

    easeIn(a, b, percent) {
        return a + (b - a) * Math.pow(percent, 2);
    }

    // Procedurally generate a chunk of road
    generateChunk(chunkIndex) {
        // Simple procedural logic: every chunk is roughly a set of segments
        // We'll generate a few straights, curves, or hills depending on theme

        const CHUNK_SIZE_ROUGHLY = 500; // About 500 segments per chunk
        let segmentsGenerated = 0;

        // Seeded random based on chunkIndex would be better, but Math.random() is fine for endless

        // Start straight for chunk 0
        if (chunkIndex === 0) {
            this.addStraight(100);
            segmentsGenerated += 300;
        }

        while (segmentsGenerated < CHUNK_SIZE_ROUGHLY) {
            const r = Math.random();
            let lengthMultiplier = Math.random() * 0.5 + 0.5; // 0.5 to 1.0

            if (this.currentTheme === 'City') {
                // City: flat, tight corners, lots of straights
                if (r < 0.4) {
                    this.addStraight(Math.floor(40 * lengthMultiplier));
                    segmentsGenerated += Math.floor(40 * lengthMultiplier) * 3;
                } else {
                    // Tight corners (sharp curve)
                    const direction = Math.random() > 0.5 ? 1 : -1;
                    const sharpness = 4 + Math.random() * 3; // 4 to 7 curve
                    const curveLen = Math.floor(20 * lengthMultiplier);
                    this.addCurve(curveLen, direction * sharpness, 0);
                    segmentsGenerated += curveLen * 3;
                }
            } else {
                // Mountain: steep hills, deep valleys, flowing curves
                if (r < 0.2) {
                    this.addStraight(Math.floor(30 * lengthMultiplier));
                    segmentsGenerated += Math.floor(30 * lengthMultiplier) * 3;
                } else if (r < 0.6) {
                    // Flowing curves with height
                    const direction = Math.random() > 0.5 ? 1 : -1;
                    const sharpness = 2 + Math.random() * 3; // 2 to 5 curve
                    const height = (Math.random() > 0.5 ? 1 : -1) * (1500 + Math.random() * 2500);
                    const curveLen = Math.floor(50 * lengthMultiplier);
                    this.addCurve(curveLen, direction * sharpness, height);
                    segmentsGenerated += curveLen * 3;
                } else {
                    // Just hills
                    const height = (Math.random() > 0.5 ? 1 : -1) * (2000 + Math.random() * 3000);
                    const hillLen = Math.floor(60 * lengthMultiplier);
                    this.addHill(hillLen, height);
                    segmentsGenerated += hillLen * 3;
                }
            }
        }
    }

    update(playerPosition) {
        // Check if we need to generate more road ahead
        // We want to always have at least `visibleSegments` ahead of the player
        const playerSegmentIndex = Math.floor(playerPosition / this.segmentLength);

        // If player is close to the end of the generated segments
        if (this.segments.length - playerSegmentIndex < this.visibleSegments * 2) {
            this.generationOffset++;
            this.generateChunk(this.generationOffset);
        }

        // Memory management: remove segments that are far behind the player
        // Keep a buffer behind the player so rendering/hills don't break instantly
        const bufferBehind = 50;
        if (playerSegmentIndex > bufferBehind && this.segments.length > 0) {
            // Because our getSegment accesses by index, if we shift the array,
            // the index vs array position changes. A robust way to handle infinite
            // arrays without memory leaks in JS is to delete old references or use
            // a sliding window approach with offset.

            // To prevent memory leak in this prototype, we'll null out old segment references
            // to allow garbage collection, rather than slicing the array which would mess up `getSegment` indices.
            const indexToClear = playerSegmentIndex - bufferBehind;
            if (indexToClear >= 0 && this.segments[indexToClear] !== null) {
                this.segments[indexToClear] = null;
            }
        }
    }
}
