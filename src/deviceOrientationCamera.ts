import * as THREE from "three";

/**
 * Applies device orientation (gyroscope) data to the camera.
 * Call `enable()` after a user gesture (required for iOS permission).
 */
export class DeviceOrientationCamera {
  private camera: THREE.Camera;
  private enabled = false;
  private alpha = 0;
  private beta = 0;
  private gamma = 0;
  private initialAlpha: number | null = null;

  private zee = new THREE.Vector3(0, 0, 1);
  private euler = new THREE.Euler();
  private q0 = new THREE.Quaternion();
  private q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° around X

  private onDeviceOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha === null) return;
    if (this.initialAlpha === null) this.initialAlpha = e.alpha;
    this.alpha = THREE.MathUtils.degToRad(e.alpha - this.initialAlpha);
    this.beta = THREE.MathUtils.degToRad(e.beta ?? 0);
    this.gamma = THREE.MathUtils.degToRad(e.gamma ?? 0);
  };

  constructor(camera: THREE.Camera) {
    this.camera = camera;
  }

  async enable(): Promise<boolean> {
    // iOS 13+ requires permission
    const DOE = DeviceOrientationEvent as any;
    if (typeof DOE.requestPermission === "function") {
      try {
        const permission = await DOE.requestPermission();
        if (permission !== "granted") return false;
      } catch {
        return false;
      }
    }

    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    this.enabled = true;
    return true;
  }

  disable() {
    window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    this.enabled = false;
  }

  /** Call in your render/update loop. */
  update() {
    if (!this.enabled) return;

    // Standard device orientation → camera quaternion conversion
    // See: https://w3c.github.io/deviceorientation/#worked-example
    this.euler.set(this.beta, this.alpha, -this.gamma, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.quaternion.multiply(this.q1); // adjust for screen orientation
    this.camera.quaternion.multiply(
      this.q0.setFromAxisAngle(this.zee, -window.orientation ? THREE.MathUtils.degToRad(window.orientation as number) : 0),
    );
  }
}
