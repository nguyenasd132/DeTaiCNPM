import {
  AllergyItem,
  AllergyWarningDto,
  ChronicConditionItem,
  MedicineContraindications
} from '../types';

function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function extractNames(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const names: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      names.push(item.trim());
    } else if (item && typeof item === 'object' && 'name' in item) {
      const val = (item as { name?: unknown }).name;
      if (typeof val === 'string' && val.trim()) {
        names.push(val.trim());
      }
    }
  }
  return names;
}

export interface MedicineForAllergyCheck {
  id: string;
  name: string;
  genericName: string | null;
  contraindications: unknown;
}

export function checkMedicineAllergies(
  patientAllergiesRaw: unknown,
  patientChronicRaw: unknown,
  medicines: MedicineForAllergyCheck[]
): AllergyWarningDto[] {
  const patientAllergies = extractNames(patientAllergiesRaw as (AllergyItem | string)[]);
  const patientConditions = extractNames(patientChronicRaw as (ChronicConditionItem | string)[]);

  const warnings: AllergyWarningDto[] = [];

  for (const med of medicines) {
    const contra = (med.contraindications || {}) as MedicineContraindications;
    const medAllergens = Array.isArray(contra.allergens) ? contra.allergens : [];
    const medConditions = Array.isArray(contra.conditions) ? contra.conditions : [];

    const searchableMedAllergyTexts = [
      med.name,
      med.genericName || '',
      ...medAllergens
    ]
      .filter(Boolean)
      .map(normalizeText);

    const matchedAllergens: string[] = [];
    for (const allergy of patientAllergies) {
      const normAllergy = normalizeText(allergy);
      if (!normAllergy) continue;
      const hit = searchableMedAllergyTexts.some(
        (target) => target.includes(normAllergy) || normAllergy.includes(target)
      );
      if (hit) {
        matchedAllergens.push(allergy);
      }
    }

    const matchedConditions: string[] = [];
    const normalizedMedConditions = medConditions.map(normalizeText).filter(Boolean);
    for (const condition of patientConditions) {
      const normCond = normalizeText(condition);
      if (!normCond) continue;
      const hit = normalizedMedConditions.some(
        (target) => target.includes(normCond) || normCond.includes(target)
      );
      if (hit) {
        matchedConditions.push(condition);
      }
    }

    if (matchedAllergens.length > 0 || matchedConditions.length > 0) {
      const parts: string[] = [];
      if (matchedAllergens.length > 0) {
        parts.push(`Dị ứng: ${matchedAllergens.join(', ')}`);
      }
      if (matchedConditions.length > 0) {
        parts.push(`Bệnh nền chống chỉ định: ${matchedConditions.join(', ')}`);
      }
      if (contra.warningText) {
        parts.push(contra.warningText);
      }

      warnings.push({
        medicineId: med.id,
        medicineName: med.name,
        matchedAllergens,
        matchedConditions,
        severity: matchedAllergens.length > 0 ? 'HIGH' : 'MODERATE',
        message: `Cảnh báo kê đơn ${med.name}: ${parts.join(' • ')}`
      });
    }
  }

  return warnings;
}
