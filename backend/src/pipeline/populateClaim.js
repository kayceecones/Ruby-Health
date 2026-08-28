function pointerLetter(index) {
  return String.fromCharCode(65 + index);
}

export function populateClaim(facts, codes) {
  const diagnoses = codes
    .filter((c) => c.codeType === "ICD-10")
    .map((c, i) => ({ pointer: pointerLetter(i), code: c.code, description: c.description }));

  const serviceLines = codes
    .filter((c) => c.codeType === "CPT")
    .map((c) => ({
      code: c.code,
      description: c.description,
      diagnosisPointers: diagnoses.length ? diagnoses[0].pointer : "",
      units: 1,
    }));

  return {
    patient: {
      name: "Sample Patient (synthetic)",
      dob: "1990-01-01",
      sex: "U",
      memberId: "SAMPLE-0001",
    },
    provider: {
      name: "Dr. Sample Provider",
      npi: "0000000000",
      address: "123 Main St, Sample City, ST 00000",
    },
    payer: {
      name: "Sample Payer Insurance",
      payerId: "00000",
    },
    dateOfService: new Date().toISOString().slice(0, 10),
    chiefComplaint: facts.chiefComplaint || "",
    medicalNecessityNotes: Array.isArray(facts.medicalNecessityLanguage)
      ? facts.medicalNecessityLanguage.join("\n")
      : "",
    diagnoses,
    serviceLines,
  };
}
