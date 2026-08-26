/**
 * TowerSystem — run progression (spec §2.1).
 *
 * Owns which floor is active, how many attempts remain, and the currency earned
 * so far. Rewards are handed to Economy so the §7 meta layer can be built on top
 * without touching combat code.
 */

import { FLOORS } from '../data/floors.js';

export default class TowerSystem {
  constructor(scene) {
    this.scene = scene;
    /**
     * Which floor table this run climbs. Defence and Ascent are two tracks of the
     * same length and shape (see data/ascentFloors.js), so progression, the floor
     * plaque and the attempt pips are shared rather than duplicated per mode.
     */
    this.floors = FLOORS;
    this.floor = 1;
    this.lives = 3;
    this.clearedFloors = [];
  }

  /** Switches tracks and starts that run from the bottom. */
  setTrack(floors) {
    this.floors = floors?.length ? floors : FLOORS;
    this.resetRun();
  }

  get config() {
    return this.floors[Math.min(Math.max(1, this.floor), this.total) - 1];
  }

  get total() {
    return this.floors.length;
  }

  get isFinalFloor() {
    return this.floor >= this.total;
  }

  get runComplete() {
    return this.clearedFloors.length >= this.total;
  }

  get runOver() {
    return this.lives <= 0;
  }

  /** Records a clear and grants the floor reward. */
  clearFloor() {
    const cfg = this.config;
    if (!this.clearedFloors.includes(this.floor)) this.clearedFloors.push(this.floor);
    this.scene.economy.grant(cfg.reward);
    return cfg.reward;
  }

  advance() {
    if (this.isFinalFloor) return false;
    this.floor += 1;
    return true;
  }

  /** A defeat costs an attempt; the floor itself is retried. */
  loseLife() {
    this.lives = Math.max(0, this.lives - 1);
    return this.lives;
  }

  resetRun() {
    this.floor = 1;
    this.lives = 3;
    this.clearedFloors = [];
  }

  /** Static description used by the intro banner. */
  brief() {
    const cfg = this.config;
    return { title: cfg.title, brief: cfg.brief, floor: cfg.floor, total: this.total };
  }

  static all() {
    return FLOORS;
  }
}
