// ============================================================================
// CONFIG: every gameplay tuning value lives in this one file.
// Change numbers here; no other file should hard-code balance values.
// ============================================================================

export const CONFIG = {
    // ------------------------------------------------------------------------
    // Time & environment: a single persistent world with one continuous cycle.
    time: {
        dayLengthMinutes: 24,      // real minutes for one full 24 h game day
        startHour: 9.5,            // clock when a new game starts
        envRefreshHours: 0.5,      // re-bake reflections every N game hours
    },
};
