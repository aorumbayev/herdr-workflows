import { z } from "zod";
import { refineRawStep } from "./step-refine";

export const rawStepSchema = z.record(z.string(), z.unknown()).superRefine(refineRawStep);

export type RawStep = z.infer<typeof rawStepSchema>;
