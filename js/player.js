class Player {
    constructor() {
        this.x = 0; // horizontal position on the road (-1 to 1)
        this.y = 0; // vertical position (height)
        this.z = 0; // position along the track

        this.speed = 0;
        this.maxSpeed = SEGMENT_LENGTH * 60; // Max speed approx 12000
        this.accel = this.maxSpeed / 5;
        this.breaking = -this.maxSpeed;
        this.decel = -this.maxSpeed / 5;
        this.offRoadDecel = -this.maxSpeed / 2;
        this.offRoadLimit = this.maxSpeed / 4;

        // Steering
        this.steeringSpeed = 0.005; // steering horizontal speed per dt

        // Input state
        this.keyLeft = false;
        this.keyRight = false;
        this.keyUp = false;
        this.keyDown = false;

        this.setupControls();
    }

    setupControls() {
        window.addEventListener('keydown', (e) => this.handleInput(e, true));
        window.addEventListener('keyup', (e) => this.handleInput(e, false));
    }

    handleInput(e, isKeyDown) {
        switch (e.code) {
            case 'ArrowLeft':
            case 'KeyA':
                this.keyLeft = isKeyDown;
                break;
            case 'ArrowRight':
            case 'KeyD':
                this.keyRight = isKeyDown;
                break;
            case 'ArrowUp':
            case 'KeyW':
                this.keyUp = isKeyDown;
                break;
            case 'ArrowDown':
            case 'KeyS':
                this.keyDown = isKeyDown;
                break;
        }
    }

    update(dt, road) {
        const playerSegment = road.getSegment(this.z);
        if (!playerSegment) return;

        const speedPercent = this.speed / this.maxSpeed;

        // Centrifugal force when cornering
        const centrifugal = speedPercent * speedPercent * playerSegment.curve * dt;

        // Steering - reduced steering speed multiplier
        const actualSteering = this.steeringSpeed * 500 * dt;
        if (this.keyLeft) {
            this.x -= actualSteering * speedPercent;
        }
        else if (this.keyRight) {
            this.x += actualSteering * speedPercent;
        }

        // Apply centrifugal force
        this.x -= centrifugal;

        // Acceleration / Braking
        if (this.keyUp) {
            this.speed += this.accel * dt;
        } else if (this.keyDown) {
            this.speed += this.breaking * dt;
        } else {
            this.speed += this.decel * dt;
        }

        // Off-road logic
        if ((this.x < -1 || this.x > 1) && this.speed > this.offRoadLimit) {
            this.speed += this.offRoadDecel * dt;
        }

        // Clamp speed
        this.speed = Math.max(0, Math.min(this.speed, this.maxSpeed));

        // Clamp x (so player doesn't go infinitely off-screen)
        this.x = Math.max(-2, Math.min(this.x, 2));

        // Move forward
        this.z += this.speed * dt;

        // Handle hills (update Y)
        const currentSegment = road.getSegment(this.z);
        if (currentSegment) {
            // Interpolate Y between current and next segment using the currentSegment's bounds
            const percent = (this.z % road.segmentLength) / road.segmentLength;
            this.y = currentSegment.p1.world.y + (currentSegment.p2.world.y - currentSegment.p1.world.y) * percent;
        }
    }

    reset() {
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.speed = 0;
        this.keyLeft = false;
        this.keyRight = false;
        this.keyUp = false;
        this.keyDown = false;
    }
}
