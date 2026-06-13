-- Migration: Add participants_json column to packages table for simulation student access control.
-- Created: 2026-06-13

ALTER TABLE packages ADD COLUMN participants_json TEXT DEFAULT '[]';
