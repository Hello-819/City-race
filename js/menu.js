class Menu {
    constructor(onStartGame) {
        this.menuElement = document.getElementById('main-menu');
        this.hudElement = document.getElementById('hud');

        this.btnCity = document.getElementById('btn-city');
        this.btnMountain = document.getElementById('btn-mountain');

        this.btnCity.addEventListener('click', () => {
            this.hideMenu();
            onStartGame('City');
        });

        this.btnMountain.addEventListener('click', () => {
            this.hideMenu();
            onStartGame('Mountain');
        });
    }

    showMenu() {
        this.menuElement.classList.add('active');
        this.hudElement.classList.remove('active');
    }

    hideMenu() {
        this.menuElement.classList.remove('active');
        this.hudElement.classList.add('active');
    }
}
