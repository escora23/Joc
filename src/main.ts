import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.getElementById('app')!.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 3);
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), new THREE.MeshStandardMaterial({ color: 0x2266aa }));
scene.add(globe, new THREE.DirectionalLight(0xffffff, 3));
renderer.setAnimationLoop(() => { globe.rotation.y += 0.01; renderer.render(scene, camera); });
(window as any).__ready = true;
